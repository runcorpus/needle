import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateway, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { ContextContainer, contextStorage } from "../../node_modules/eve/dist/src/context/container.js";
import { isAccountError } from "../harnesses/native-scoring";
import { CorpusClient } from "../lib/corpus-cli";
import { budgetApproval, INPUT_BUDGET, OUTPUT_BUDGET, withAnswerReserve } from "./budget";
import { languageModel } from "./model";
import { createNeedleRetrievalAgent, defineNeedleRetrievalEvals } from "./needle-retrieval";
import { completeClippedSnippet, recordExtractedFile, recordFetchedFile } from "./passages";
import { completeLeadingPassage } from "./web-fetch";
import { readAcceptedResults, validateRanking, type RankedResult } from "./results";
import { candidatePool, phase, retrieve } from "./retrieval-flow";
import { readSessionSearches } from "./search-evidence";
import { writeRecord } from "./session-files";
import { assertAcceptableEveErrors } from "./runner";

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

test("ranked snippets are checked against indexed evidence or verified fetched passages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "needle-results-"));
  const url = "https://example.com/doc.pdf";
  const source = "First line\nExact source text.\nLast line.";
  const bytes = new TextEncoder().encode("PDF bytes");
  let content = new TextEncoder().encode(source);
  const path = "/workspace/document.txt";
  const evidence = [{ hit: { url, meta: { title: "Document", description: "Indexed text." } } }] as RankedResult[];
  const check = (snippet: string) => validateRanking([{ url, title: "Document", snippet }], evidence, directory,
    { async readBinaryFile() { return content; } }, new AbortController().signal, 100);
  try {
    await recordFetchedFile(directory, "/workspace/doc.pdf", url, bytes);
    await recordExtractedFile(directory, "/workspace/doc.pdf", path, bytes, source, 3);
    expect((await check("Exact source text.")).ranked?.[0]?.hit.passage?.source).toEqual({ type: "web_fetch", startLine: 2, endLine: 2 });
    content = new TextEncoder().encode(source + "edited");
    expect((await check("Exact source text.")).ranked?.[0]?.hit.meta.description).toBe("Indexed text.");
    expect((await check("Indexed")).ranked?.[0]?.hit.meta.description).toBe("Indexed");
    expect((await check("unverified")).warnings).toHaveLength(1);
    const long = "A".repeat(120);
    evidence[0]!.hit.meta.description = long;
    expect((await check(long)).ranked?.[0]?.hit.meta.description).toBe(long.slice(0, 100));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clipped lead uses a unique, verbatim continuation within the published limit", async () => {
  const lead = "A new study tracked water quality across eight towns";
  const description = "Feed: " + lead + "…";
  const paragraph = lead.replace("water quality", "water\nquality") + " and found concentrations fell by half in six months.";
  const page = "Article\n\n" + paragraph + "\n\nNavigation links.";
  expect(completeClippedSnippet(description, page, 2000)).toBe(paragraph);
  expect(completeClippedSnippet(description, page, 90)).toBe(paragraph.slice(0, 90).trimEnd());
  expect(completeClippedSnippet(description, page + page, 2000)).toBeUndefined();
  expect(completeClippedSnippet(lead, page, 2000)).toBeUndefined();
  expect(completeClippedSnippet("The city council confirmed " + lead + "…", page, 2000)).toBeUndefined();
  expect(completeClippedSnippet("eight towns…", page, 2000)).toBeUndefined();

  const root = await mkdtemp(join(tmpdir(), "needle-complete-"));
  const url = "https://example.com/study";
  const hit = { url, urn: "urn:study", score: 1, meta: { title: "Study", description } };
  const ctx = { session: { id: "parent" }, abortSignal: new AbortController().signal,
    getSandbox: async () => ({ readBinaryFile: async () => new TextEncoder().encode(page) }) };
  const directory = join(root, ctx.session.id);
  try {
    await recordFetchedFile(directory, "/page", url, page, 6);
    const passage = await completeLeadingPassage(root, "index", hit, 2000, ctx as never);
    expect(passage).toEqual({ snippet: paragraph, source: { type: "web_fetch", startLine: 3, endLine: 4 } });
    expect(await completeLeadingPassage(root, "index", { ...hit, passage }, 2000, ctx as never)).toBeUndefined();
    // Another URL cannot use this page. Its retry cannot issue a second fetch.
    await Bun.write(join(directory, "leading-passage-attempt"), "");
    expect(await completeLeadingPassage(root, "index", { ...hit, url: url + "-other" }, 2000, ctx as never)).toBeUndefined();
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
    const dir = join(directory, "session");
    await writeRecord(dir, "phase", "discover");
    const catalogQuery = { corpus: indexSnapshot.ref, q: "Collection description", k: 3, meta: true };
    expect(await harness.corpusSearch.execute(catalogQuery, child as never)).toMatchObject({ hits: [{ meta: { corpus: "org/corpus" } }] });
    await contextStorage.run(new ContextContainer(), async () => {
      expect(await harness.selectCollections.execute({ refs: ["invented"] }, root as never)).toHaveProperty("error");
      expect(await harness.selectCollections.execute({ refs: ["org/corpus"] }, child as never)).toHaveProperty("error");
      expect(await harness.selectCollections.execute({ refs: ["org/corpus"] }, root as never)).toEqual({ selected: true });
      const client = new CorpusClient("https://example.com", indexSnapshot);
      await retrieve(client, dir, ["org/corpus"], originalQuestion, 5, { [ref]: snapshot }, { signal: root.abortSignal }, "initial");
      expect(attachPinned).toHaveBeenCalledTimes(1);
      expect(search).toHaveBeenLastCalledWith(snapshot.id, originalQuestion, 5, expect.any(Object));
      await writeRecord(dir, "phase", "rank");
      expect(await harness.corpusSearch.execute(catalogQuery, child as never)).toHaveProperty("error");
      const [id] = candidatePool(await readSessionSearches(dir), indexSnapshot.id).keys();
      const ctx = { ...root, async getSandbox() { return {}; } } as never;
      const item = { id: id!, snippet: "Indexed" };
      const recovery = { kind: "documents" as const, ref, query: "new wording", reason: "missing identifier" };
      expect(await harness.recordRanking.execute({ results: [{ ...item, id: "unknown" }] }, ctx)).toHaveProperty("error");
      expect(await harness.recordRanking.execute({ results: [item, item] }, ctx)).toHaveProperty("error");
      expect(await harness.recordRanking.execute({ results: [item], recovery }, ctx)).toHaveProperty(allowQueryRewrite ? "recorded" : "error");
      expect(await harness.recordRanking.execute({ results: [] }, ctx)).toHaveProperty("recorded");
      await writeRecord(dir, "phase", "rerank");
      expect(await harness.recordRanking.execute({ results: [], recovery: { kind: "catalog", query: "new lead", reason: "missing" } }, ctx)).toHaveProperty("error");
      expect(await harness.corpusSearch.execute(catalogQuery, root as never)).toHaveProperty("error");
    });
  } finally {
    attachPinned.mockRestore(); attach.mockRestore(); search.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["catalog", "documents"] as const)("controller performs one %s recovery and pools both passes", async kind => {
  const sessionDir = await mkdtemp(join(tmpdir(), "needle-controller-"));
  const directory = join(sessionDir, "parent");
  const question = "original question";
  const index = { ref: "_/index:latest", id: "index", tag: "latest", labels: {}, documents: 2, uri: null };
  const options = { sessionDir, registry: "https://example.com", agentModel: "test/model", indexSnapshot: index,
    zeroDataRetention: true, k: 3, snippetChars: 100, allowQueryRewrite: kind === "documents" };
  const agent = createNeedleRetrievalAgent(options);
  const data = (text: string, ref?: string) => ({ urn: text, url: "https://example.com/" + text, score: 1,
    meta: { title: text, description: text, ...(ref ? { corpus: ref } : {}) } });
  const search = spyOn(CorpusClient.prototype, "search").mockImplementation(async (id, q) =>
    id === "index" ? [data(q, q === "first lookup" ? "org/one" : "org/two")] : [data(id + q)]);
  const attach = spyOn(CorpusClient.prototype, "attachAndInfo").mockImplementation(async ref => ({
    ...index, ref: ref.includes(":") ? ref : ref + ":latest", id: ref.split(":")[0]!,
  }));
  const signal = new AbortController().signal;
  const ctx = { session: { id: "parent" }, abortSignal: signal, callId: "initial", async getSandbox() { return {}; } } as never;
  const stages: string[] = [];
  const session = { id: "parent", async send() {
    const stage = await phase(directory);
    stages.push(stage);
    if (stage === "discover") {
      await agent.corpusSearch.execute({ corpus: index.ref, q: "first lookup", k: 3, meta: true }, ctx);
      await agent.selectCollections.execute({ refs: ["org/one"] }, ctx);
    } else if (stage === "select-recovery") {
      await agent.selectCollections.execute({ refs: ["org/two"] }, ctx);
    } else {
      const pool = candidatePool(await readSessionSearches(directory), index.id);
      const results = [...pool].map(([id, { hit }]) => ({ id, snippet: hit.meta.description })).reverse();
      const recovery = kind === "catalog" ? { kind, query: "second lookup", reason: "missing source" }
        : { kind, ref: "org/one:latest", query: "rewrite", reason: "missing identifier" };
      await agent.recordRanking.execute({ results, recovery: stage === "rank" ? recovery : undefined }, ctx);
    }
    return { expectOk() {} };
  } };
  try {
    await contextStorage.run(new ContextContainer(), async () => {
      const [evaluation] = defineNeedleRetrievalEvals([{ queryText: question, index: 0 }], options);
      await evaluation!.test({ async session() { return session; }, abortSignal: signal } as never);
    });
    expect(stages).toEqual(kind === "catalog" ? ["discover", "rank", "select-recovery", "rerank"] : ["discover", "rank", "rerank"]);
    expect((await readAcceptedResults(directory))?.length).toBe(2);
    expect(JSON.parse(await readFile(join(directory, "rank-decision.json"), "utf8")).ranked).toHaveLength(1);
    const documentCalls = search.mock.calls.filter(([id]) => id !== "index");
    expect(documentCalls.map(([id, q]) => [id, q])).toEqual([["org/one", question], kind === "catalog" ? ["org/two", question] : ["org/one", "rewrite"]]);
  } finally {
    search.mockRestore();
    attach.mockRestore();
    await rm(sessionDir, { recursive: true, force: true });
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
    expect(budgetApproval({ toolName: "record_ranking" })).toBeUndefined();
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
