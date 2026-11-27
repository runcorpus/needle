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
import type { Ranking } from "./retrieval-flow";
import type { NeedleEveAgentOptions, NeedleEveCase } from "./needle-retrieval";
import { checkpointDigest, isCheckpointSnapshot, type CaseCheckpoints } from "./checkpoints";
import { readSessionSearches, type SearchEvidence } from "./search-evidence";
import { readRecords, writeRecord } from "./session-files";
import { publicRunJson } from "../lib/public-run-json";
import type { EveEvalResult } from "eve/evals";
import { modelSettings } from "./model";
import { readAcceptedResults } from "./results";
import { sessionPath } from "./search-evidence";

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
      usage?: Partial<TokenUsage>;
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

function normalizeUsage(raw?: Partial<TokenUsage>): TokenUsage | null {
  if (!raw) return null;
  const inputTokens = typeof raw.inputTokens === "number" ? raw.inputTokens : null;
  const outputTokens = typeof raw.outputTokens === "number" ? raw.outputTokens : null;
  const totalTokens =
    typeof raw.totalTokens === "number"
      ? raw.totalTokens
      : inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null;
  return {
    inputTokens, outputTokens, totalTokens,
    ...(typeof raw.cacheReadTokens === "number" ? { cacheReadTokens: raw.cacheReadTokens } : {}),
    ...(typeof raw.costUsd === "number" ? { costUsd: raw.costUsd } : {}),
  };
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
  checkpoint?: { store: CaseCheckpoints; keys: Record<number, string> },
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

    const { indexSnapshot, registry, zeroDataRetention, k, snippetChars, allowQueryRewrite, scope, pinnedCorpora } = params;
    const module = JSON.stringify(join(eveModuleBase, "needle-retrieval.ts"));
    await writeFile(
      join(agentDir, "agent.ts"),
      `import { createNeedleRetrievalAgent } from ${module};
export const harness = createNeedleRetrievalAgent(${JSON.stringify({
        indexSnapshot, registry, agentModel, zeroDataRetention, k, snippetChars, sessionDir, allowQueryRewrite, pinnedCorpora,
        scope: allowQueryRewrite ? scope : undefined,
      })});
export default harness.agent;
`,
    );
    const sandboxTools = {
      bash: join(eveModuleBase, "bash.ts"),
      grep: join(eveModuleBase, "grep.ts"),
      read_file: "eve/tools/read_file",
      write_file: "eve/tools/write_file",
      edit_file: "eve/tools/edit_file",
    };
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
      writeFile(join(toolsDir, "corpus_search.ts"), 'import { harness } from "../agent";\nexport default harness.corpusSearch;\n'),
      writeFile(join(toolsDir, "web_fetch.ts"), `import { webFetchTool } from ${JSON.stringify(join(eveModuleBase, "web-fetch.ts"))};\nexport default webFetchTool(${JSON.stringify(sessionDir)}, ${JSON.stringify(indexSnapshot.id)});\n`),
      writeFile(join(toolsDir, "read_document.ts"), `import { readDocumentTool } from ${JSON.stringify(join(eveModuleBase, "read-document.ts"))};\nexport default readDocumentTool(${JSON.stringify(sessionDir)});\n`),
      writeFile(join(toolsDir, "web_search.ts"), 'import { disableTool } from "eve/tools";\nexport default disableTool();\n'),
      writeFile(join(toolsDir, "select_collections.ts"), 'import { harness } from "../agent";\nexport default harness.selectCollections;\n'),
      writeFile(join(toolsDir, "record_ranking.ts"), 'import { harness } from "../agent";\nexport default harness.recordRanking;\n'),
      ...Object.entries(sandboxTools).map(([name, module]) => writeFile(
        join(toolsDir, `${name}.ts`),
        `export { default } from ${JSON.stringify(module)};\n`,
      )),
      writeFile(
        join(evalsDir, `${suite}.eval.ts`),
        `import { readFileSync } from "node:fs";
import { defineNeedleRetrievalEvals } from ${module};
const cases = JSON.parse(readFileSync(${JSON.stringify(casesFile)}, "utf8"));
export default defineNeedleRetrievalEvals(cases, ${JSON.stringify({ sessionDir, indexSnapshot, registry, k, pinnedCorpora })});
`,
      ),
      writeFile(
        join(evalsDir, "evals.config.ts"),
        `import { defineEvalConfig } from "eve/evals";
${checkpoint ? `import { checkpointReporter } from ${JSON.stringify(join(eveModuleBase, "runner.ts"))};` : ""}
export default defineEvalConfig({ maxConcurrency: ${maxConcurrency}, timeoutMs: 300_000, reporters: [${checkpoint ? `checkpointReporter(${JSON.stringify(params)}, ${JSON.stringify(sessionDir)}, ${JSON.stringify(checkpoint.store.directory)}, ${JSON.stringify(checkpoint.keys)})` : ""}] });
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
    const uploads = checkpoint && setInterval(() => { void checkpoint.store.flush(); }, 1000);
    try {
      await child.exited;
    } finally {
      if (uploads) clearInterval(uploads);
      await checkpoint?.store.flush();
    }

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

type EveTiming = NonNullable<ProviderQueryResult["timing"]>;

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

interface CaseReport extends EveCaseDetailFile {
  verdict: string;
  error?: string;
}

async function collectCase(params: NeedleEveRunParams, report: CaseReport, sessionDir: string): Promise<NeedleEveResult> {
  const detail = report.result;
  if (!detail) throw new Error("Eve did not produce a retrieval report.");
  const directory = detail.sessionId ? sessionPath(sessionDir, detail.sessionId) : null;
  const allSearches = directory ? await readSessionSearches(directory) : [];
  const catalog = allSearches.filter(({ snapshot }) => snapshot.id === params.indexSnapshot.id);
  const searches = allSearches.filter(({ snapshot }) => snapshot.id !== params.indexSnapshot.id);
  const indexHits = new Map<string, DiscoveryIndexHit>();
  for (const { hits } of catalog) {
    for (const hit of hits) {
      const ref = typeof hit.meta.corpus === "string" ? hit.meta.corpus : hit.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/+$/, "");
      const entry = { corpus: ref, title: hit.meta.title, description: hit.meta.description, score: hit.score };
      const previous = indexHits.get(ref);
      if (!previous || previous.score < entry.score) indexHits.set(ref, entry);
    }
  }
  const ranked = directory ? await readAcceptedResults(directory) : null;
  const first: Ranking | undefined = ranked && directory
    ? JSON.parse(await readFile(join(directory, "rank-decision.json"), "utf8")) : undefined;
  const recovery = first?.recovery && directory ? {
    ...first.recovery,
    elapsedMs: Number(await readFile(join(directory, "recovery-ms.json"), "utf8")),
  } : undefined;
  const attached = directory ? await readRecords<CorpusSnapshotRef>(join(directory, "attachments")) : [];
  const snapshots = [...new Map([...attached, ...searches.map(({ snapshot }) => snapshot)].map((snapshot) => [snapshot.ref, snapshot])).values()];
  const selected = ranked?.[0]?.snapshot ?? searches[0]?.snapshot;
  const searchedCorpora = [...new Set(searches.map(({ snapshot }) => snapshot.ref))];
  const failed = ranked === null || report.verdict !== "passed";
  const validation = detail.derived?.toolCalls?.findLast((call) => call.name === "record_ranking")?.output?.error;
  const eveError = typeof validation === "string" ? validation : report.error?.trim();
  const reasoning = failed
    ? (eveError ? `Eve retrieval failed: ${eveError}` : "Eve retrieval did not complete successfully.")
    : ranked?.length ? `Eve submitted ${ranked.length} ranked results after searching ${searchedCorpora.length} corpora.`
    : searchedCorpora.length ? "Eve returned no relevant URLs." : "Eve found no applicable corpus to search.";
  return {
    discovery: {
      status: failed ? "error" : selected ? "found" : "not_found",
      mode: "eve", model: params.agentModel,
      ...(params.allowQueryRewrite && params.scope ? { projectScope: params.scope } : {}),
      ...(first ? { firstRanking: first.ranked.map(({ hit }) => ({
        url: hit.url, title: hit.meta.title, snippet: hit.passage?.snippet ?? hit.meta.description, published_date: typeof hit.meta.published_date === "string" ? hit.meta.published_date : undefined,
      })) } : {}),
      ...(recovery ? { recovery } : {}),
      indexQueries: catalog.map(({ query }) => query), indexHits: [...indexHits.values()].sort((a, b) => b.score - a.score),
      selectedCorpus: selected?.ref.split(":")[0] ?? null, searchedCorpora,
      searchQueries: searches.map(({ snapshot, query }) => ({ corpus: snapshot.ref, query })),
      resolvedTag: selected?.ref ?? null, resolvedSnapshotId: selected?.id ?? null,
      reasoning, usage: normalizeUsage(detail.derived?.usage),
    },
    hits: failed ? [] : (ranked ?? []).map(({ hit }) => hit), snapshots,
    queriedAt: report.startedAt ?? new Date().toISOString(),
    ...(failed ? {} : { timing: await readEveTiming(sessionDir, detail.sessionId, searches) }),
  };
}

export function checkpointReporter(params: NeedleEveRunParams, sessionDir: string, directory: string, keys: Record<number, string>) {
  return {
    onRunStart() {},
    onRunComplete() {},
    async onEvalComplete(entry: EveEvalResult) {
      if (entry.verdict !== "passed") return;
      const position = Number(entry.id.slice(entry.id.lastIndexOf("/") + 1));
      const row = params.cases[position];
      if (!row || !keys[row.index]) throw new Error("Unexpected checkpoint case identity.");
      const result = await collectCase(params, entry as unknown as CaseReport, sessionDir);
      if (result.discovery.status !== "error" && publicRunJson(result) === JSON.stringify(result)) {
        await writeRecord(directory, keys[row.index], result);
        console.log(`[checkpoint] Saved question ${row.index + 1}.`);
      }
    },
  };
}

function runNeedleEveGroup(params: NeedleEveRunParams, checkpoint?: { store: CaseCheckpoints; keys: Record<number, string> }): Promise<Map<number, NeedleEveResult>> {
  return runEveProject(params, async ({ reportDir, summary, sessionDir }) => {
    const evals = new Map(summary.evals?.map((entry) => [entry.id, entry]));
    const results = new Map<number, NeedleEveResult>();
    for (const [position, row] of params.cases.entries()) {
      const id = `${params.suite}/${String(position).padStart(4, "0")}`;
      const entry = evals.get(id);
      const report = await readEveCase(reportDir, id);
      if (!entry || !report) throw new Error(`Eve did not produce a retrieval report for ${id}.`);
      results.set(row.index, await collectCase(params, { ...report, verdict: entry.verdict, error: entry.error }, sessionDir));
    }
    return results;
  }, checkpoint);
}

function isCheckpointResult(value: unknown): value is NeedleEveResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<NeedleEveResult>;
  return !!result.discovery && ["error", "found", "not_found"].includes(result.discovery.status)
    && Array.isArray(result.hits) && Array.isArray(result.snapshots) && result.snapshots.every(isCheckpointSnapshot)
    && typeof result.queriedAt === "string";
}

export function caseCheckpointKey(params: NeedleEveRunParams, row: NeedleEveCase) {
  return `${params.suite}-${row.index}-${checkpointDigest([
    "bounded-recovery-v1", params.indexSnapshot.id, row.queryText, modelSettings("answer", params.agentModel), params.zeroDataRetention,
    params.allowQueryRewrite, params.allowQueryRewrite ? params.scope : undefined,
    params.k, params.snippetChars, params.pinnedCorpora,
  ])}`;
}

export async function runNeedleEveSuite(params: NeedleEveRunParams, checkpoints?: CaseCheckpoints) {
  const results = new Map<number, NeedleEveResult>();
  const pending: NeedleEveCase[] = [];
  const pins = { ...params.pinnedCorpora };
  const keys: Record<number, string> = {};
  for (const row of params.cases) {
    const key = caseCheckpointKey(params, row);
    keys[row.index] = key;
    const saved = await checkpoints?.read(key);
    if (isCheckpointResult(saved) && saved.discovery.status !== "error"
      && saved.discovery.projectScope === (params.allowQueryRewrite ? params.scope : undefined)) {
      results.set(row.index, saved);
      for (const snapshot of saved.snapshots) pins[snapshot.ref] = snapshot;
    } else pending.push(row);
  }
  if (checkpoints) console.log(`[checkpoint] ${results.size}/${params.cases.length} completed questions restored. Checkpoints: ${checkpoints.directory}`);
  if (pending.length) {
    const fresh = await runNeedleEveGroup({ ...params, cases: pending, pinnedCorpora: pins }, checkpoints ? { store: checkpoints, keys } : undefined);
    for (const [index, result] of fresh) results.set(index, result);
  }
  assertAcceptableEveErrors(params.suite, results);
  return new Map(params.cases.map(({ index }) => [index, results.get(index)!]));
}
