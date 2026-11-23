import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateway, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { ContextContainer, contextStorage } from "../../node_modules/eve/dist/src/context/container.js";
import { CorpusClient } from "../lib/corpus-cli";
import { budgetApproval, INPUT_BUDGET, OUTPUT_BUDGET, withAnswerReserve } from "./budget";
import { fitJevEvidence } from "./judge-evidence";
import { languageModel } from "./model";
import { createNeedleRetrievalAgent } from "./needle-retrieval";
import { rankNeedleHits } from "./runner";
import { wrapMarkdown } from "./wrap-markdown";

test("Eve removes only the spurious Gateway token-pass deprecation", async () => {
  const otherWarning = { type: "deprecated", setting: "legacy-setting", message: "Use its replacement." } as const;
  const warnings = [
    { type: "deprecated", setting: "providerOptions key 'token-pass'", message: "Use 'tokenPass' instead." } as const,
    otherWarning,
  ];
  const textDelta = { type: "text-delta", id: "text", delta: "ok" } as const;
  const inner = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings,
    },
    doStream: {
      stream: simulateReadableStream({
        chunks: [{ type: "stream-start", warnings } as const, textDelta],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    },
  });
  const createModel = spyOn(gateway, "languageModel").mockReturnValue(inner);
  const previousProvider = process.env.AGENT_PROVIDER;
  process.env.AGENT_PROVIDER = "vercel";
  try {
    const model = languageModel("answer", "test/model");
    const params = { prompt: [], providerOptions: { gateway: { zeroDataRetention: true } } };
    const result = await model.doGenerate(params);
    expect(result.warnings).toEqual([otherWarning]);
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    const { stream } = await model.doStream(params);
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual({ type: "stream-start", warnings: [otherWarning] });
    expect((await reader.read()).value).toEqual(textDelta);
    expect((await reader.read()).done).toBe(true);
    expect(inner.doGenerateCalls[0]?.providerOptions).toEqual(params.providerOptions);
    expect(inner.doStreamCalls[0]?.providerOptions).toEqual(params.providerOptions);
  } finally {
    createModel.mockRestore();
    if (previousProvider === undefined) delete process.env.AGENT_PROVIDER;
    else process.env.AGENT_PROVIDER = previousProvider;
  }
});

test("NEEDLE scores only retrieved URLs in Eve's order at the published depth", () => {
  function search(corpus: string, urls: string[]) {
    return {
      snapshot: { ref: `org/${corpus}:latest`, tag: "latest", id: corpus, uri: null, documents: urls.length, labels: {} },
      hits: urls.map((url) => ({ url, urn: url, score: 1, meta: { title: url, description: corpus } })),
    };
  }
  const a = "https://example.com/a";
  const b = "https://example.com/b";
  const c = "https://example.com/c";
  const searches = [search("first", [a, b, c]), search("second", [b, "https://example.com/d"])];
  const ranked = rankNeedleHits(["https://example.com/unseen", b, b, a, c], searches, 2);
  expect(ranked.map(({ hit }) => hit.url)).toEqual([b, a]);
  expect(ranked[0]?.hit.meta.description).toBe("first");
});

test.each([false, true])("retrieval supports repeated searches with rewriting %s", async (allowQueryRewrite) => {
  const directory = await mkdtemp(join(tmpdir(), "needle-search-"));
  const ref = "org/corpus:latest";
  const snapshot = { ref, tag: "latest", id: "snapshot", uri: null, documents: 1, labels: {} };
  const originalQuestion = "Find the original question";
  const indexSearch = spyOn(CorpusClient.prototype, "searchIndex").mockResolvedValue([
    { corpus: "org/corpus", title: "Corpus", description: "Fixture", score: 1 },
  ]);
  const attachPinned = spyOn(CorpusClient.prototype, "attachPinned").mockResolvedValue(snapshot);
  const corpusSearch = spyOn(CorpusClient.prototype, "search").mockResolvedValue([]);
  const harness = createNeedleRetrievalAgent({
    indexSnapshot: snapshot,
    registry: "https://example.com",
    agentModel: "test/model",
    zeroDataRetention: true,
    k: 5,
    snippetChars: 2000,
    sessionDir: directory,
    allowQueryRewrite,
    pinnedCorpora: { [ref]: snapshot },
  });

  try {
    await mkdir(join(directory, "session"));
    await writeFile(join(directory, "session", "query.txt"), originalQuestion);
    await contextStorage.run(new ContextContainer(), async () => {
      for (let call = 1; call <= 4; call++) {
        const query = `Rewritten query ${call}`;
        expect(await harness.indexSearch.execute({ keywords: query }, {} as never)).toHaveProperty("hits");
        const context = { session: { id: "session" }, callId: String(call) } as never;
        const input = { corpus: ref, ...(allowQueryRewrite ? { query } : {}) };
        expect(await harness.corpusSearch.execute(input, context)).toEqual({ corpus: ref, hits: [] });
        expect(corpusSearch).toHaveBeenLastCalledWith(snapshot.id, allowQueryRewrite ? query : originalQuestion, 5);
      }
    });
    expect(indexSearch).toHaveBeenCalledTimes(4);
    expect(attachPinned).toHaveBeenCalledWith(snapshot);
    expect(corpusSearch).toHaveBeenCalledTimes(4);
  } finally {
    indexSearch.mockRestore();
    attachPinned.mockRestore();
    corpusSearch.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Eve allows research beyond 100,000 input tokens and reserves the final ranking", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const inner = new MockLanguageModelV4({
      doStream: async () => ({ stream: new ReadableStream({ start: (controller) => controller.close() }) }),
    });
    const params: Parameters<typeof inner.doStream>[0] = {
      prompt: [{ role: "user", content: [{ type: "text", text: "Rank the URLs" }] }],
      tools: [{ type: "function", name: "corpus_search", inputSchema: { type: "object" } }],
    };
    await withAnswerReserve(inner, { inputTokens: 110_000, outputTokens: 4096 }, 4096).doStream(params);
    expect(inner.doStreamCalls[0]?.maxOutputTokens).toBe(4096);
    expect(budgetApproval()).toBeUndefined();

    await withAnswerReserve(inner, { inputTokens: 195_000, outputTokens: 4096 }, 4096).doStream(params);
    expect(INPUT_BUDGET).toBe(200_000);
    expect(OUTPUT_BUDGET).toBe(32_768);
    expect(inner.doStreamCalls[1]?.maxOutputTokens).toBe(16_384);
    expect(JSON.stringify(inner.doStreamCalls[1]?.prompt.at(-1))).toContain("Follow the required output format");
    expect(budgetApproval()).toMatchObject({ type: "denied" });
  });
});

describe("Eve CorpusQA helpers", () => {
  test("fitJevEvidence leaves small evidence batches unchanged", () => {
    const state = { question: "What is the LEI of Palantir?", reference: "549300UVN46B3BBDHO85", answer: "549300UVN46B3BBDHO85" };
    const questions = { accuracy: { type: "choice", expected: "A" } };
    const evidence = [{ name: "corpus_search", input: { q: "Palantir" }, output: { hits: [{ url: "https://api.gleif.org/api/v1/lei-records/549300UVN46B3BBDHO85" }] } }];
    expect(fitJevEvidence(state, questions, evidence)).toBe(evidence);
  });

  test("fitJevEvidence truncates oversized evidence batches below 24 KiB", () => {
    const state = { question: "q", reference: "r", answer: "a" };
    const questions = { accuracy: { type: "choice", expected: "A" } };
    const huge = "word ".repeat(8000);
    const evidence = [
      { name: "web_fetch", input: { url: "https://example.com/a" }, output: { url: "https://example.com/a", content: huge } },
      { name: "web_fetch", input: { url: "https://example.com/b" }, output: { url: "https://example.com/b", content: huge } },
    ];
    const fitted = fitJevEvidence(state, questions, evidence);
    expect(fitted).not.toBe(evidence);
    expect(Buffer.byteLength(JSON.stringify({ state: { ...state, evidence: fitted }, questions }))).toBeLessThanOrEqual(24 * 1024);
  });

  test("wrapMarkdown wraps long paragraphs while preserving tables", () => {
    const longPara = Array.from({ length: 25 }, (_, i) => `sentence${i} word`).join(" ");
    const wrapped = wrapMarkdown(longPara);
    expect(wrapped).toContain("\n");

    const tableRow = "| col1 | " + "x".repeat(200) + " |";
    expect(wrapMarkdown(tableRow)).toBe(tableRow);
  });
});
