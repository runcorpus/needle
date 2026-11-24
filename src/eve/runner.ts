import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CorpusSearchHit,
  CorpusSnapshotRef,
  DiscoveryIndexHit,
  DiscoveryOutcome,
  ProviderQueryResult,
  TokenUsage,
} from "../lib/types";
import type { NeedleEveAgentOptions, NeedleEveCase } from "./needle-retrieval";
import { isCheckpointSnapshot, runScholarGroups, type ScholarCheckpoints } from "./checkpoints";
import { sessionPath, type SearchEvidence } from "./search-evidence";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVALS_WORK_DIR = join(REPO_ROOT, ".evals");
const DEFAULT_MAX_CONCURRENCY = 4;

export interface NeedleEveRunParams extends Omit<NeedleEveAgentOptions, "sessionDir"> {
  suite: string;
  cases: NeedleEveCase[];
  maxConcurrency?: number;
}

interface EveSummaryFile {
  evals?: Array<{
    id: string;
    verdict: string;
    error?: string;
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

function resolveMaxConcurrency(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.EVE_MAX_CONCURRENCY?.trim();
  if (!raw) return DEFAULT_MAX_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`EVE_MAX_CONCURRENCY must be a positive integer (got "${raw}").`);
  }
  return parsed;
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

/** Stage and run a retrieval batch with Eve, then read its report before cleaning up the project. */
async function runEveProject<T>(
  params: NeedleEveRunParams,
  collect: (report: { reportDir: string; summary: EveSummaryFile; eveVersion: string; sessionDir: string }) => Promise<T>,
): Promise<T> {
  const { suite, cases, agentModel } = params;
  const maxConcurrency = resolveMaxConcurrency(params.maxConcurrency);

  const { major } = checkNodeMajor();
  if (major < 24) {
    throw new Error(
      `Eve requires Node.js >= 24 (detected Node v${major}). Run with Node 24+ (configured in .github/workflows/refresh-harness.yml).`,
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
        dependencies: { eve: evePkg.version },
      }),
    );
    await writeFile(casesFile, JSON.stringify(cases, null, 2));

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
      writeFile(
        join(agentDir, "sandbox.ts"),
        `import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

export const environment = JustBashSandbox.environment({ autoInstall: false });
export default defineSandbox(() => environment.open());
`,
      ),
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
      writeFile(
        join(evalsDir, "evals.config.ts"),
        `import { defineEvalConfig } from "eve/evals";
export default defineEvalConfig({ maxConcurrency: ${maxConcurrency}, timeoutMs: 300_000 });
`,
      ),
    ]);

    // Keep traces when the temporary project is removed.
    const eveStateDir = join(projectDir, ".eve");
    await mkdir(eveStateDir, { recursive: true });
    await symlink(tracesDir, join(eveStateDir, "traces"), "dir");

    console.log(`[eve-retrieval] Launching Eve ${evePkg.version} for ${suite} (${cases.length} cases, maxConcurrency=${maxConcurrency})...`);
    const env = { ...process.env };
    delete env.ACTIONS_RUNTIME_TOKEN;
    const child = Bun.spawn(["node", eveCli, "eval", suite, "--max-concurrency", String(maxConcurrency)], {
      cwd: projectDir,
      env,
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

interface NeedleCorpusSearch {
  snapshot: CorpusSnapshotRef;
  hits: CorpusSearchHit[];
}

type EveTiming = NonNullable<ProviderQueryResult["timing"]>;

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

export function assertAcceptableEveErrors(suite: string, results: ReadonlyMap<number, { discovery: { status: string; reasoning: string } }>) {
  if (!results.size) return;
  const errors = [...results.values()].filter(({ discovery }) => discovery.status === "error");
  if (!errors.length) return;
  const maxAllowed = Math.max(2, Math.floor(results.size * 0.1));
  if (errors.length === results.size || errors.length > maxAllowed) {
    const sample = errors[0]?.discovery.reasoning ?? "Unknown error";
    throw new Error(
      `Eve retrieval failed for ${errors.length}/${results.size} queries in ${suite} (threshold: ${maxAllowed}). First error: ${sample}`,
    );
  }
}

function runNeedleEveGroup(params: NeedleEveRunParams): Promise<Map<number, NeedleEveResult>> {
  const { suite, cases, agentModel, k } = params;
  return runEveProject(params, async ({ reportDir, summary, sessionDir }) => {
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
      const eveError = entry.error?.trim();
      const reasoning = failed
        ? (eveError ? `Eve retrieval failed: ${eveError}` : "Eve retrieval did not complete successfully.")
        : ranked.length ? `Eve ranked ${ranked.length} retrieved ${ranked.length === 1 ? "URL" : "URLs"} after searching ${searchedCorpora.length} corpus.`
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
    return results;
  });
}

function isCheckpointResult(value: unknown): value is NeedleEveResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<NeedleEveResult>;
  return !!result.discovery && ["error", "found", "not_found"].includes(result.discovery.status)
    && Array.isArray(result.hits) && Array.isArray(result.snapshots) && result.snapshots.every(isCheckpointSnapshot)
    && typeof result.queriedAt === "string";
}

export async function runNeedleEveSuite(params: NeedleEveRunParams, checkpoints?: ScholarCheckpoints) {
  const results = checkpoints ? await runScholarGroups({
    checkpoints,
    suite: params.suite,
    cases: params.cases,
    indexId: params.indexSnapshot.id,
    initialPins: params.pinnedCorpora,
    isResult: isCheckpointResult,
    runGroup: (cases, start, pinnedCorpora) => runNeedleEveGroup({
      ...params, suite: `${params.suite}-${start}`, cases, pinnedCorpora,
    }),
  }) : await runNeedleEveGroup(params);
  assertAcceptableEveErrors(params.suite, results);
  return results;
}
