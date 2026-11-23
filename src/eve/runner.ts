import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CorpusQACompatibleOutcome,
  CorpusSearchHit,
  CorpusSnapshotRef,
  DiscoveryIndexHit,
  DiscoveryOutcome,
  TokenUsage,
} from "../lib/types";
import type { EveEvalCaseInput } from "./index";
import type { NeedleEveAgentOptions, NeedleEveCase } from "./needle-retrieval";
import { sessionPath, type SearchEvidence } from "./search-evidence";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVALS_WORK_DIR = join(REPO_ROOT, ".evals");

export interface EveRunParams {
  suite: string;
  cases: EveEvalCaseInput[];
  indexSnapshot: CorpusSnapshotRef;
  k: number;
  registry: string;
  agentModel: string;
  judgeModel: string;
  maxConcurrency?: number;
}

export interface EveRunOutput {
  outcomesByIndex: Map<number, CorpusQACompatibleOutcome>;
  retrievalByIndex: Map<number, { hits: CorpusSearchHit[]; timing: EveTiming }>;
  resolvedCorpora: Record<string, CorpusSnapshotRef>;
  eveVersion: string;
}

export interface NeedleEveRunParams extends Omit<NeedleEveAgentOptions, "sessionDir"> {
  suite: string;
  cases: NeedleEveCase[];
  maxConcurrency?: number;
}

type EveProjectParams = (EveRunParams & { mode: "answer" }) | (NeedleEveRunParams & { mode: "retrieval" });

interface EveSummaryFile {
  evals?: Array<{
    id: string;
    verdict: string;
    error?: string;
    assertions?: Array<{
      name?: string;
      passed?: boolean;
      errored?: boolean;
      message?: string;
      metadata?: {
        judge?: string;
        judgeModel?: string;
        answer?: {
          type?: string;
          choice?: string;
          reasoning?: string;
          rationale?: string;
        };
        usage?: {
          inputTokens?: number | null;
          outputTokens?: number | null;
          totalTokens?: number | null;
        };
      };
    }>;
  }>;
}

interface EveCaseDetailFile {
  id?: string;
  startedAt?: string;
  logs?: string[];
  result?: {
    reply?: string;
    data?: unknown;
    sessionId?: string;
    derived?: {
      toolCalls?: Array<{
        callId?: string;
        name: string;
        status: string;
        input?: Record<string, unknown>;
        output?: Record<string, unknown>;
      }>;
      usage?: {
        inputTokens?: number | null;
        outputTokens?: number | null;
        totalTokens?: number | null;
      };
    };
  };
}

function normalizeUsage(raw?: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
}): TokenUsage | null {
  if (!raw) return null;
  const inputTokens = typeof raw.inputTokens === "number" ? raw.inputTokens : null;
  const outputTokens = typeof raw.outputTokens === "number" ? raw.outputTokens : null;
  const totalTokens =
    typeof raw.totalTokens === "number"
      ? raw.totalTokens
      : inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null;
  return { inputTokens, outputTokens, totalTokens };
}

function checkNodeMajor(): { bin: string; major: number } {
  const proc = Bun.spawnSync(["node", "-p", "process.versions.node"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const versionStr = new TextDecoder().decode(proc.stdout).trim();
  const major = Number.parseInt(versionStr.split(".")[0] ?? "0", 10);
  return { bin: "node", major };
}

/** Stage and run a batch with Eve, then read its report before cleaning up the project. */
async function runEveProject<T>(
  params: EveProjectParams,
  collect: (report: { reportDir: string; summary: EveSummaryFile; eveVersion: string; sessionDir: string }) => Promise<T>,
): Promise<T> {
  const { suite, cases, mode, agentModel, maxConcurrency = 8 } = params;

  const { major } = checkNodeMajor();
  if (major < 24) {
    throw new Error(
      `Eve requires Node.js >= 24 (detected Node v${major}). Run with Node 24+ (configured in .github/workflows/refresh.yml).`,
    );
  }

  const evePkg = JSON.parse(
    await readFile(join(REPO_ROOT, "node_modules", "eve", "package.json"), "utf8"),
  ) as { version: string };
  const eveCli = fileURLToPath(
    new URL("../../node_modules/eve/bin/eve.js", import.meta.url),
  );

  await mkdir(EVALS_WORK_DIR, { recursive: true });
  const tracesDir = join(EVALS_WORK_DIR, "traces");
  await mkdir(tracesDir, { recursive: true });

  const projectDir = await mkdtemp(join(EVALS_WORK_DIR, "project-corpus-"));
  const agentDir = join(projectDir, "agent");
  const toolsDir = join(agentDir, "tools");
  const evalsDir = join(projectDir, "evals");
  const sessionDir = join(projectDir, "retrieval-sessions");
  await Promise.all([
    mkdir(toolsDir, { recursive: true }),
    mkdir(evalsDir, { recursive: true }),
  ]);

  const eveModuleBase = join(REPO_ROOT, "src", "eve");
  const casesFile = join(projectDir, "cases.json");

  try {
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          eve: evePkg.version,
          ...(mode === "answer" ? { "@kreuzberg/node": "4.10.2" } : {}),
        },
      }),
    );
    await writeFile(casesFile, JSON.stringify(cases, null, 2));

    if (mode === "answer") {
      const { indexSnapshot, registry, judgeModel, k } = params;
      const kreuzbergDest = join(projectDir, "node_modules", "@kreuzberg", "node");
      await mkdir(join(kreuzbergDest, ".."), { recursive: true });
      await symlink(
        await realpath(join(REPO_ROOT, "node_modules", "@kreuzberg", "node")),
        kreuzbergDest,
        "dir",
      );

      // Stage the CorpusQA agent, sandbox, and tools as in @corpusd/qa.
      await writeFile(
        join(agentDir, "agent.ts"),
        `import { createCorpusEveHarness } from ${JSON.stringify(join(eveModuleBase, "index.ts"))};
export const harness = createCorpusEveHarness({
  indexSnapshot: ${JSON.stringify(indexSnapshot)},
  sessionDir: ${JSON.stringify(sessionDir)},
  retrievalDepth: ${k},
  registry: ${JSON.stringify(registry)},
  model: ${JSON.stringify(agentModel)},
  searchLimit: 10,
  maxSearches: 10,
});
export default harness.agent;
`,
      );
      await writeFile(
        join(toolsDir, "search_corpus_index.ts"),
        `import { harness } from "../agent";\nexport default harness.searchIndexTool;\n`,
      );
      await writeFile(
        join(toolsDir, "corpus_search.ts"),
        `import { harness } from "../agent";\nexport default harness.corpusSearchTool;\n`,
      );

      await writeFile(
        join(agentDir, "instructions.ts"),
        `import { harness } from "./agent";\nexport default harness.instructions;\n`,
      );
      await writeFile(
        join(agentDir, "sandbox.ts"),
        `export { default, environment } from ${JSON.stringify(join(eveModuleBase, "sandbox.ts"))};\n`,
      );
      await writeFile(
        join(toolsDir, "bash.ts"),
        `export { default } from ${JSON.stringify(join(eveModuleBase, "bash.ts"))};\n`,
      );
      await writeFile(
        join(toolsDir, "grep.ts"),
        `export { default } from ${JSON.stringify(join(eveModuleBase, "grep.ts"))};\n`,
      );
      await writeFile(
        join(toolsDir, "web_fetch.ts"),
        `export { default } from ${JSON.stringify(join(eveModuleBase, "web-fetch.ts"))};\n`,
      );
      await writeFile(
        join(toolsDir, "read_document.ts"),
        `export { default } from ${JSON.stringify(join(eveModuleBase, "read-document.ts"))};\n`,
      );
      await writeFile(
        join(toolsDir, "web_search.ts"),
        `import { disableTool } from "eve/tools";\nexport default disableTool();\n`,
      );

      await writeFile(
        join(evalsDir, `${suite}.eval.ts`),
        `import { readFileSync } from "node:fs";
import { defineNeedleEveEvals, type EveEvalCaseInput } from ${JSON.stringify(join(eveModuleBase, "index.ts"))};
const cases = JSON.parse(readFileSync(${JSON.stringify(casesFile)}, "utf8")) as EveEvalCaseInput[];
export default defineNeedleEveEvals({
  suite: ${JSON.stringify(suite)},
  cases,
  sessionDir: ${JSON.stringify(sessionDir)},
  k: ${k},
  agentModel: ${JSON.stringify(agentModel)},
  judgeModel: ${JSON.stringify(judgeModel)},
});
`,
      );
    } else {
      const { indexSnapshot, registry, zeroDataRetention, k, snippetChars, allowQueryRewrite, pinnedCorpora } = params;
      const module = JSON.stringify(join(eveModuleBase, "needle-retrieval.ts"));
      await writeFile(
        join(agentDir, "agent.ts"),
        `import { createNeedleRetrievalAgent } from ${module};
export const harness = createNeedleRetrievalAgent(${JSON.stringify({
          indexSnapshot, registry, agentModel, zeroDataRetention, k, snippetChars, sessionDir, allowQueryRewrite, pinnedCorpora,
        })});
export default harness.agent;
`,
      );
      await Promise.all([
        writeFile(join(agentDir, "instructions.ts"), 'import { harness } from "./agent";\nexport default harness.instructions;\n'),
        writeFile(join(toolsDir, "index_search.ts"), 'import { harness } from "../agent";\nexport default harness.indexSearch;\n'),
        writeFile(join(toolsDir, "corpus_search.ts"), 'import { harness } from "../agent";\nexport default harness.corpusSearch;\n'),
        writeFile(
          join(evalsDir, `${suite}.eval.ts`),
          `import { readFileSync } from "node:fs";
import { defineNeedleRetrievalEvals } from ${module};
const cases = JSON.parse(readFileSync(${JSON.stringify(casesFile)}, "utf8"));
export default defineNeedleRetrievalEvals(cases, ${JSON.stringify(sessionDir)}, ${k});
`,
        ),
      ]);
    }
    await writeFile(
      join(evalsDir, "evals.config.ts"),
      `import { defineEvalConfig } from "eve/evals";
export default defineEvalConfig({ maxConcurrency: ${maxConcurrency}, timeoutMs: 300_000 });
`,
    );

    // Keep traces when the temporary project is removed.
    const eveStateDir = join(projectDir, ".eve");
    await mkdir(eveStateDir, { recursive: true });
    await symlink(tracesDir, join(eveStateDir, "traces"), "dir");

    console.log(`[eve-${mode}] Launching Eve ${evePkg.version} for ${suite} (${cases.length} cases)...`);
    const child = Bun.spawn(["node", eveCli, "eval", suite, "--max-concurrency", String(maxConcurrency)], {
      cwd: projectDir,
      stdout: "inherit",
      stderr: "inherit",
    });
    await child.exited;

    const evalsOutRoot = join(eveStateDir, "evals");
    const runDirs = (await readdir(evalsOutRoot)).sort();
    const latestRunDir = runDirs.at(-1);
    if (!latestRunDir) {
      throw new Error(`Eve produced no eval output directory under ${evalsOutRoot}`);
    }
    const reportDir = join(evalsOutRoot, latestRunDir);
    const summary = JSON.parse(
      await readFile(join(reportDir, "summary.json"), "utf8"),
    ) as EveSummaryFile;

    return await collect({ reportDir, summary, eveVersion: evePkg.version, sessionDir });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function readEveCase(reportDir: string, id: string): Promise<EveCaseDetailFile | null> {
  try {
    return JSON.parse(await readFile(join(reportDir, "evals", `${id}.json`), "utf8")) as EveCaseDetailFile;
  } catch {
    return null;
  }
}

export function runEveSuite(params: EveRunParams): Promise<EveRunOutput> {
  const { suite, cases, agentModel, judgeModel, k } = params;
  return runEveProject({ ...params, mode: "answer" }, async ({ reportDir, summary, eveVersion, sessionDir }) => {
    const outcomesByIndex = new Map<number, CorpusQACompatibleOutcome>();
    const retrievalByIndex: EveRunOutput["retrievalByIndex"] = new Map();
    const evals = new Map(summary.evals?.map((entry) => [entry.id, entry]));
    const resolvedCorpora: Record<string, CorpusSnapshotRef> = {};
    const testedAt = new Date().toISOString();

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      const expectedId = `${suite}/${String(i).padStart(4, "0")}`;
      const evalEntry = evals.get(expectedId);
      const detail = await readEveCase(reportDir, expectedId);
      if (!evalEntry || !detail?.result) throw new Error(`Eve did not report ${expectedId}.`);

      const toolCalls = detail.result.derived?.toolCalls ?? [];
      const searches: SearchEvidence[] = [];
      const indexQueries: string[] = [];
      const selectedCorporaSet = new Set<string>();
      const searchQueries: Array<{ corpus: string; query: string; hitsCount: number }> = [];
      const fetchedUrls: string[] = [];

      for (const tc of toolCalls) {
        if (tc.status !== "completed") continue;
        if (tc.name === "search_corpus_index" && typeof tc.input?.q === "string") {
          indexQueries.push(tc.input.q);
        } else if (tc.name === "corpus_search") {
          const search = await readSearchEvidence(sessionDir, detail.result.sessionId, tc.callId);
          searches.push(search);
          const corpusRef = search.snapshot.ref;
          resolvedCorpora[corpusRef] = search.snapshot;
          selectedCorporaSet.add(corpusRef);
          if (typeof tc.input?.q === "string") {
            searchQueries.push({ corpus: corpusRef, query: tc.input.q, hitsCount: search.hits.length });
          }
        } else if (tc.name === "web_fetch" && typeof tc.input?.url === "string") {
          fetchedUrls.push(tc.input.url);
        }
      }

      const discoveryFailed = searchQueries.length === 0;
      const judgeAssertion = evalEntry?.assertions?.find(
        (a) => a.name?.startsWith("judge.") || a.metadata?.answer?.choice,
      );
      const rawChoice = judgeAssertion?.metadata?.answer?.choice?.trim().toUpperCase();
      const probs = (judgeAssertion?.metadata?.answer as { probabilities?: Record<string, number> } | undefined)
        ?.probabilities;
      const probSuffix = probs
        ? ` (p(A)=${(probs.A ?? 0).toFixed(2)}, p(B)=${(probs.B ?? 0).toFixed(2)}, p(C)=${(probs.C ?? 0).toFixed(2)})`
        : "";

      const data = detail.result.data as { answer?: unknown; urls?: unknown } | undefined;
      const answer = typeof data?.answer === "string" ? data.answer : null;
      const urls = stringUrls(data?.urls);
      const failed = answer === null || urls === null || (discoveryFailed && toolCalls.some(({ status }) => status === "failed"));
      if (!failed) {
        retrievalByIndex.set(c.index, {
          hits: rankNeedleHits(urls, searches, k).map(({ hit }) => hit),
          timing: await readEveTiming(sessionDir, detail.result.sessionId, searches),
        });
      }
      let verdict: CorpusQACompatibleOutcome["verdict"] = "error";
      let reasoning = "";

      if (failed) {
        reasoning = "Eve did not return a usable answer and evidence list.";
      } else if (c.answer === null) {
        verdict = "ungraded";
        reasoning = "This suite grades retrieval relevance.";
      } else if (discoveryFailed) {
        verdict = "C";
        reasoning =
          "Immediate fail: agent did not discover or complete any corpus_search via _/index:latest.";
      } else if (rawChoice === "A" || rawChoice === "B" || rawChoice === "C") {
        verdict = rawChoice;
        reasoning =
          judgeAssertion?.metadata?.answer?.reasoning ??
          judgeAssertion?.metadata?.answer?.rationale ??
          `Jev graded ${rawChoice}${probSuffix}.`;
      } else if (evalEntry?.error) {
        verdict = "error";
        reasoning = evalEntry.error;
      } else if (evalEntry?.verdict === "passed" && judgeAssertion) {
        verdict = "A";
        reasoning = `Passed Eve Jev accuracy gate${probSuffix}.`;
      } else {
        verdict = "error";
        reasoning = judgeAssertion?.message ?? "No Jev choice recorded.";
      }

      outcomesByIndex.set(c.index, {
        engine: "corpus",
        verdict,
        passed: verdict === "A",
        answer: answer?.trim() ?? "",
        reasoning,
        discoveryFailed,
        indexQueries,
        selectedCorpora: [...selectedCorporaSet],
        searchQueries,
        fetchedUrls,
        testedAt,
        agentModel,
        judgeModel: judgeAssertion?.metadata?.judge ?? judgeAssertion?.metadata?.judgeModel ?? judgeModel,
        usage: {
          agent: normalizeUsage(detail?.result?.derived?.usage),
          judge: normalizeUsage(judgeAssertion?.metadata?.usage),
        },
      });
    }

    return {
      outcomesByIndex,
      retrievalByIndex,
      resolvedCorpora,
      eveVersion,
    };
  });
}

interface NeedleCorpusSearch {
  snapshot: CorpusSnapshotRef;
  hits: CorpusSearchHit[];
}

type EveTiming = NonNullable<import("../lib/types").ProviderQueryResult["timing"]>;

function stringUrls(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((url) => typeof url === "string") ? value : null;
}

async function readSearchEvidence(root: string, sessionId?: string, callId?: string): Promise<SearchEvidence> {
  if (!sessionId || !callId) throw new Error("Eve did not record the corpus search identity.");
  const file = join(sessionPath(root, sessionId), `${encodeURIComponent(callId)}.json`);
  return JSON.parse(await readFile(file, "utf8")) as SearchEvidence;
}

async function readEveTiming(root: string, sessionId: string | undefined, searches: SearchEvidence[]): Promise<EveTiming> {
  if (!sessionId) throw new Error("Eve did not record the session identity.");
  const agentMs = JSON.parse(await readFile(join(sessionPath(root, sessionId), "turn-ms.json"), "utf8")) as number;
  return { agentMs, searchMs: searches.map(({ searchMs }) => searchMs) };
}

interface NeedleEveResult {
  discovery: DiscoveryOutcome;
  hits: CorpusSearchHit[];
  snapshots: CorpusSnapshotRef[];
  queriedAt: string;
  timing?: EveTiming;
}

export function rankNeedleHits(urls: string[], searches: NeedleCorpusSearch[], k: number) {
  const byUrl = new Map<string, { hit: CorpusSearchHit; snapshot: CorpusSnapshotRef }>();
  for (const { snapshot, hits } of searches) {
    for (const hit of hits) {
      if (hit.url && !byUrl.has(hit.url)) byUrl.set(hit.url, { hit, snapshot });
    }
  }
  return [...new Set(urls)].flatMap((url) => {
    const match = byUrl.get(url);
    return match ? [match] : [];
  }).slice(0, k);
}

export function runNeedleEveSuite(params: NeedleEveRunParams): Promise<Map<number, NeedleEveResult>> {
  const { suite, cases, agentModel, k } = params;
  return runEveProject({ ...params, mode: "retrieval" }, async ({ reportDir, summary, sessionDir }) => {
    const evals = new Map(summary.evals?.map((entry) => [entry.id, entry]));
    const results = new Map<number, NeedleEveResult>();
    for (const [position, row] of cases.entries()) {
      const id = `${suite}/${String(position).padStart(4, "0")}`;
      const entry = evals.get(id);
      const report = await readEveCase(reportDir, id);
      if (!entry || !report?.result) throw new Error(`Eve did not produce a retrieval report for ${id}.`);
      const detail = report.result;
      const indexQueries: string[] = [];
      const indexHits = new Map<string, DiscoveryIndexHit>();
      const searches: SearchEvidence[] = [];
      const calls = detail.derived?.toolCalls ?? [];

      for (const call of calls) {
        if (call.name === "index_search" && typeof call.input?.keywords === "string") {
          indexQueries.push(call.input.keywords);
          if (call.status === "completed" && Array.isArray(call.output?.hits)) {
            for (const hit of call.output.hits as DiscoveryIndexHit[]) {
              const previous = indexHits.get(hit.corpus);
              if (!previous || previous.score < hit.score) indexHits.set(hit.corpus, hit);
            }
          }
        }
        if (call.name === "corpus_search" && call.status === "completed" && call.output?.error === undefined) {
          searches.push(await readSearchEvidence(sessionDir, detail.sessionId, call.callId));
        }
      }

      const urls = stringUrls((detail.data as { urls?: unknown } | undefined)?.urls);
      const ranked = urls ? rankNeedleHits(urls, searches, k) : [];
      const snapshots = searches.map(({ snapshot }) => snapshot);
      const selected = ranked[0]?.snapshot ?? snapshots[0];
      const searchedCorpora = [...new Set(snapshots.map(({ ref }) => ref))];
      const failed = !urls || entry.verdict !== "passed"
        || !calls.some((call) => call.name === "index_search" && call.status === "completed" && call.output?.error === undefined)
        || (!ranked.length && calls.some((call) => call.status === "failed"));
      const reasoning = failed ? "Eve retrieval did not complete successfully."
        : ranked.length ? `Eve ranked ${ranked.length} retrieved URLs after searching ${searchedCorpora.length} corpora.`
        : urls.length ? "Eve returned no URLs backed by a corpus search."
        : searchedCorpora.length ? "Eve returned no relevant URLs."
        : "Eve found no applicable corpus to search.";
      results.set(row.index, {
        discovery: {
          status: failed ? "error" : selected ? "found" : "not_found",
          mode: "eve",
          model: agentModel,
          indexQueries,
          indexHits: [...indexHits.values()].sort((a, b) => b.score - a.score),
          selectedCorpus: selected?.ref.split(":")[0] ?? null,
          searchedCorpora,
          searchQueries: searches.map(({ snapshot, query }) => ({ corpus: snapshot.ref, query })),
          resolvedTag: selected?.ref ?? null,
          resolvedSnapshotId: selected?.id ?? null,
          reasoning,
          usage: normalizeUsage(detail.derived?.usage),
        },
        hits: failed ? [] : ranked.map(({ hit }) => hit),
        snapshots,
        queriedAt: report.startedAt ?? new Date().toISOString(),
        ...(failed ? {} : { timing: await readEveTiming(sessionDir, detail.sessionId, searches) }),
      });
    }
    if (results.size > 0 && [...results.values()].every(({ discovery }) => discovery.status === "error")) {
      throw new Error(`Eve retrieval failed for all ${results.size} queries in ${suite}. See the Eve trace for details.`);
    }
    return results;
  });
}
