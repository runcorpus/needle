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
import { recordExtractedFile, recordFetchedFile } from "./passages";
import { readAcceptedResults, RESULTS_PATH, submitResultsTool } from "./results";
import { assertAcceptableEveErrors } from "./runner";
import { readSessionSearches } from "./search-evidence";

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

test("results.json validates ranked evidence and allows correction before submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "needle-results-"));
  const directory = join(root, "session");
  const doc = { url: "https://example.com/doc.pdf", title: "Document", snippet: "Exact source text." };
  const other = { url: "https://example.com/other", title: "Other", snippet: "Corpus evidence." };
  const encoder = new TextEncoder();
  const originalPdf = encoder.encode("original PDF bytes");
  const longSnippet = "Source passage. ".repeat(10);
  const fetchedText = `First line\nExact source text.\nLast line.\n${longSnippet}`;
  let fetchedBytes = encoder.encode(fetchedText);
  let resultsText: string | null = null;
  const filePath = "/workspace/.read-document/document.txt";
  const context = {
    session: { id: "session" },
    abortSignal: new AbortController().signal,
    async getSandbox() {
      return {
        async readTextFile(options: { path: string }) {
          expect(options.path).toBe(RESULTS_PATH);
          return resultsText;
        },
        async readBinaryFile(options: { path: string }) {
          expect(options.path).toBe(filePath);
          return fetchedBytes;
        },
      };
    },
  } as never;
  try {
    await mkdir(join(directory, "searches"), { recursive: true });
    await writeFile(join(directory, "searches", "call.json"), JSON.stringify({
      snapshot: { ref: "org/test:latest" },
      hits: [other, { ...doc, snippet: "" }].map(({ url, title, snippet }) => ({
        url, urn: url, score: 1, meta: { title, description: snippet },
      })),
    }));
    await contextStorage.run(new ContextContainer(), async () => {
      const pdfPath = "/workspace/.web-fetch/document.pdf";
      await recordFetchedFile(directory, pdfPath, doc.url, originalPdf);
      await recordExtractedFile(directory, pdfPath, filePath, originalPdf, fetchedText, 4);
      const tool = submitResultsTool(root, 2, 100, "index");
      expect(await tool.execute({}, context)).toHaveProperty("error");
      resultsText = "not JSON";
      expect(await tool.execute({}, context)).toHaveProperty("error");
      for (const invalid of [
        [doc, other, other],
        [doc, doc],
        [{ ...doc, url: "https://example.com/unseen" }],
        [{ ...doc, title: "Invented title" }],
        [{ ...doc, snippet: 123 }],
        [{ ...doc, extra: "unexpected" }],
      ]) {
        resultsText = JSON.stringify(invalid);
        expect(await tool.execute({}, context)).toHaveProperty("error");
      }
      expect(await readAcceptedResults(directory)).toBeNull();

      resultsText = JSON.stringify([doc, { ...other, snippet: "Invented excerpt" }]);
      expect(await tool.execute({}, context)).toEqual({
        submitted: true,
        count: 2,
        warnings: ["Result 2 snippet could not be verified and was replaced with the indexed description."],
      });
      const recovered = await readAcceptedResults(directory);
      expect(recovered?.map(({ hit }) => hit.url)).toEqual([doc.url, other.url]);
      expect(recovered?.[0]?.hit.passage).toEqual({
        snippet: doc.snippet, source: { type: "web_fetch", startLine: 2, endLine: 2 },
      });
      expect(recovered?.[1]?.hit.meta.description).toBe(other.snippet);

      resultsText = JSON.stringify([
        { ...doc, title: "Invented title" },
        { ...other, url: "https://example.com/unseen" },
      ]);
      expect(await tool.execute({}, context)).toEqual({
        error: "Result 1 title must match the corpus_search result.\nResult 2 URL must come from corpus_search.",
      });
      expect(await readAcceptedResults(directory)).toEqual(recovered);

      resultsText = JSON.stringify([doc, other]);
      fetchedBytes = encoder.encode(fetchedText + "\nAn edit.");
      expect(await tool.execute({}, context)).toEqual({
        submitted: true,
        count: 2,
        warnings: ["Result 1 snippet could not be verified and was replaced with an empty string."],
      });
      const tampered = await readAcceptedResults(directory);
      expect(tampered?.map(({ hit }) => hit.url)).toEqual([doc.url, other.url]);
      expect(tampered?.[0]?.hit.passage).toBeUndefined();
      expect(tampered?.[0]?.hit.meta.description).toBe("");
      fetchedBytes = encoder.encode(fetchedText);
      expect(await tool.execute({}, context)).toEqual({ submitted: true, count: 2 });
      const results = await readAcceptedResults(directory);
      expect(results?.map(({ hit }) => hit.url)).toEqual([doc.url, other.url]);
      expect(results?.[0]?.hit.passage).toEqual({
        snippet: doc.snippet, source: { type: "web_fetch", startLine: 2, endLine: 2 },
      });

      const laterDescription = "Passage later in the indexed description.";
      await writeFile(join(directory, "searches", "long-description.json"), JSON.stringify({
        snapshot: { ref: "org/test:latest" },
        hits: [{ url: other.url, urn: other.url, score: 1, meta: {
          title: other.title, description: "Prefix ".repeat(30) + laterDescription,
        } }],
      }));
      resultsText = JSON.stringify([{ ...other, snippet: laterDescription }]);
      expect(await tool.execute({}, context)).toEqual({ submitted: true, count: 1 });
      expect((await readAcceptedResults(directory))?.[0]?.hit.meta.description).toBe(laterDescription);

      resultsText = JSON.stringify([{ ...doc, snippet: longSnippet }]);
      expect(await tool.execute({}, context)).toEqual({
        submitted: true,
        count: 1,
        warnings: ["Result 1 snippet was capped to 100 characters."],
      });
      expect((await readAcceptedResults(directory))?.[0]?.hit.passage).toEqual({
        snippet: longSnippet.slice(0, 100), source: { type: "web_fetch", startLine: 4, endLine: 4 },
      });

      resultsText = "[]";
      expect(await tool.execute({}, context)).toEqual({ submitted: true, count: 0 });
      expect(await readAcceptedResults(directory)).toEqual([]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["legal", "The user is conducting legal research. Their question is legal-related."],
  ["finance", "The user is conducting financial research. Their question is finance-related."],
  ["scholar", "The user is conducting scholarly research. Their question concerns academic papers."],
  ["news", "The user is researching news. Their question concerns news reporting."],
  ["agentic_rare", "The user is researching a rare or obscure topic."],
] as const)("project scope %s is visible only to Agent", (scope, expected) => {
  const options = {
    indexSnapshot: { ref: "_/index:latest", tag: "latest", id: "index", uri: null, documents: 17, labels: {} },
    registry: "https://example.com",
    agentModel: "test/model",
    zeroDataRetention: true,
    k: 5,
    snippetChars: 2000,
    sessionDir: "/unused",
    scope,
  };
  const agent = createNeedleRetrievalAgent({ ...options, allowQueryRewrite: true });
  const needle = createNeedleRetrievalAgent({ ...options, allowQueryRewrite: false });
  const unscoped = createNeedleRetrievalAgent({ ...options, allowQueryRewrite: false, scope: undefined });
  expect(agent.instructions.content).toContain(expected);
  expect(needle.instructions.content).not.toContain(expected);
  expect(needle.instructions.content).toBe(unscoped.instructions.content);
});

test.each([false, true])("search uses virtual question attachments with rewriting %s", async (allowQueryRewrite) => {
  const directory = await mkdtemp(join(tmpdir(), "needle-search-"));
  const ref = "org/corpus:latest";
  const snapshot = { ref, tag: "latest", id: "snapshot", uri: null, documents: 1, labels: {} };
  const indexSnapshot = { ...snapshot, ref: "_/index:latest", id: "index" };
  const originalQuestion = "Find the original question";
  const description = "Indexed description. ".repeat(120);
  const source = { url: "https://example.com/document", urn: "document", score: 1.5,
    meta: { title: "Document", description, citation: "7 CFR 1413.110", cfr_title: 7, section: "1413.110" } };
  const attachPinned = spyOn(CorpusClient.prototype, "attachPinned").mockResolvedValue(snapshot);
  const attach = spyOn(CorpusClient.prototype, "attachAndInfo").mockRejectedValue(new Error("Published corpus not found."));
  const search = spyOn(CorpusClient.prototype, "search").mockImplementation(async (id) => id === "index"
    ? [{ url: "https://example.com/org/corpus", urn: "catalog", score: 2, meta: { title: "Corpus", description: "Fixture", corpus: "org/corpus" } }]
    : [source]);
  const harness = createNeedleRetrievalAgent({ indexSnapshot, registry: "https://example.com", agentModel: "test/model",
    zeroDataRetention: true, k: 5, snippetChars: 2000, sessionDir: directory, allowQueryRewrite, pinnedCorpora: { [ref]: snapshot } });
  const root = { session: { id: "session" }, callId: "catalog", abortSignal: new AbortController().signal };
  const child = { session: { id: "child", parent: { rootSessionId: "session" } }, callId: "child", abortSignal: new AbortController().signal };
  try {
    await mkdir(join(directory, "session"));
    await writeFile(join(directory, "session", "query.txt"), originalQuestion);
    expect(await harness.corpusList.execute({}, root as never)).toEqual({ corpora: [indexSnapshot] });
    expect(await harness.corpusSearch.execute({ corpus: ref, q: "Guess", k: 5 }, root as never)).toHaveProperty("error");
    expect(search).not.toHaveBeenCalled();
    expect(await harness.corpusSearch.execute({ corpus: indexSnapshot.ref, q: "Collection description", k: 3, meta: true }, root as never)).toEqual({
      hits: [{ url: "https://example.com/org/corpus", title: "Corpus", description: "Fixture", meta: { corpus: "org/corpus" } }],
    });
    expect(search).toHaveBeenLastCalledWith("index", "Collection description", 3, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await harness.corpusAdd.execute({ corpus: "nasa/ntrs:latest" }, root as never)).toHaveProperty("error");
    expect(await harness.corpusList.execute({}, root as never)).toEqual({ corpora: [indexSnapshot] });
    await harness.corpusAdd.execute({ corpus: ref }, child as never);
    expect(await harness.corpusList.execute({}, root as never)).toEqual({ corpora: [indexSnapshot, snapshot] });
    await harness.corpusAdd.execute({ corpus: ref }, root as never);
    expect(attachPinned).toHaveBeenCalledTimes(1);
    const unrelated = { session: { id: "other-question" }, callId: "other" } as never;
    expect(await harness.corpusList.execute({}, unrelated)).toEqual({ corpora: [indexSnapshot] });
    expect(await harness.corpusSearch.execute({ corpus: ref, q: "Guess", k: 5 }, unrelated)).toHaveProperty("error");
    for (const includeMeta of [undefined, false, true]) {
      const input = { corpus: ref, q: "Rewritten query", k: 7, meta: includeMeta };
      const result = await harness.corpusSearch.execute(input, { ...child, callId: `metadata-${includeMeta}` } as never);
      const hit = { url: source.url, title: "Document", description };
      expect(result).toEqual({ hits: [includeMeta ? { ...hit, meta: { citation: "7 CFR 1413.110", cfr_title: 7, section: "1413.110" } } : hit] });
      expect(search).toHaveBeenLastCalledWith(snapshot.id, allowQueryRewrite ? input.q : originalQuestion, 7, expect.any(Object));
    }
    if (!allowQueryRewrite) {
      await harness.corpusSearch.execute({ corpus: ref, q: undefined, k: 1 }, { ...root, callId: "optional-q" } as never);
      expect(search).toHaveBeenLastCalledWith(snapshot.id, originalQuestion, 1, expect.any(Object));
    }
    const searches = await readSessionSearches(join(directory, "session"));
    expect(searches.filter(({ snapshot }) => snapshot.id !== "index")).toHaveLength(allowQueryRewrite ? 3 : 4);
    expect(searches.some(({ hits }) => hits[0]?.meta.citation === "7 CFR 1413.110")).toBe(true);
    // A prior mode's recorded snapshots must not limit the agent's discovery.
    const discovered = { ...snapshot, ref: "nasa/ntrs:latest", id: "discovered" };
    attach.mockResolvedValueOnce(discovered);
    expect(await harness.corpusAdd.execute({ corpus: discovered.ref }, root as never)).toEqual({ corpus: discovered.ref, snapshot: discovered });
    expect(attach).toHaveBeenLastCalledWith(discovered.ref, expect.any(Object));
    expect(await harness.corpusList.execute({}, root as never)).toEqual({ corpora: expect.arrayContaining([discovered]) });
  } finally {
    attachPinned.mockRestore(); attach.mockRestore(); search.mockRestore();
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
    expect(budgetApproval({ toolName: "corpus_search" })).toMatchObject({ type: "denied" });
    expect(budgetApproval({ toolName: "write_file" })).toBeUndefined();
    expect(budgetApproval({ toolName: "submit_results" })).toBeUndefined();
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
