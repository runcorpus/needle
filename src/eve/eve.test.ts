import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateway, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { ContextContainer, contextStorage } from "../../node_modules/eve/dist/src/context/container.js";
import { isAccountError } from "../harnesses/native-scoring";
import { CorpusClient } from "../lib/corpus-cli";
import { budgetApproval, INPUT_BUDGET, OUTPUT_BUDGET, withAnswerReserve } from "./budget";
import { languageModel } from "./model";
import { createNeedleRetrievalAgent } from "./needle-retrieval";
import { assertAcceptableEveErrors, rankNeedleHits } from "./runner";

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

describe("Eve error guards", () => {
  test("aborts when failure rate exceeds threshold or all queries fail", () => {
    const makeResults = (total: number, errors: number) =>
      new Map(Array.from({ length: total }, (_, i) => [
        i,
        { discovery: { status: i < errors ? "error" : "found", reasoning: i < errors ? "Eve retrieval failed: timeout" : "ok" } },
      ]));

    expect(() => assertAcceptableEveErrors("test", makeResults(20, 2))).not.toThrow();
    expect(() => assertAcceptableEveErrors("test", makeResults(20, 3))).toThrow(/3\/20 queries/);
    expect(() => assertAcceptableEveErrors("test", makeResults(100, 10))).not.toThrow();
    expect(() => assertAcceptableEveErrors("test", makeResults(100, 11))).toThrow(/11\/100 queries/);
    expect(() => assertAcceptableEveErrors("test", makeResults(1, 1))).toThrow(/1\/1 queries/);
  });

  test("distinguishes account/quota errors from service timeouts", () => {
    expect(isAccountError("HTTP 429 rate limit exceeded")).toBe(true);
    expect(isAccountError("Daily spend limit reached")).toBe(true);
    expect(isAccountError("Eve retrieval failed: The operation was aborted due to timeout")).toBe(false);
  });
});
