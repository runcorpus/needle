import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { benchmarkSuites, type CorpusWeeklyReport } from "./corpus-report";
import type { CorpusReportMode, ReportRunLink, ReportRunScore } from "./report-results";
import type {
  NeedleCompatibleArtifact,
  QuestionComparison,
  RunBundle,
  RunIndex,
  RunIndexEntry,
  RunInputsArtifact,
  RunManifest,
  VerticalId,
} from "./types";

const RUNS_DIR = join(process.cwd(), "public", "runs");
export const LOCAL_RUNS_DIR = join(process.cwd(), ".evals", "local-runs");

export function isLocalRunSlug(runSlug: string) {
  return /^[\w.-]+-preview-[1-9]\d*$/.test(runSlug);
}

function summary<T extends { questions: unknown[] }>(artifact: T | null) {
  if (!artifact) return null;
  const { questions: _details, ...rest } = artifact;
  return rest;
}

export function assembleRunBundle(
  manifest: RunManifest,
  inputs: RunInputsArtifact,
  needle: NeedleCompatibleArtifact | null,
  agent: NeedleCompatibleArtifact | null,
): RunBundle {
  const needleByIdx = new Map((needle?.questions ?? []).map((q) => [q.index, q]));
  const agentByIdx = new Map((agent?.questions ?? []).map((q) => [q.index, q]));

  const questions: QuestionComparison[] = inputs.queries.map((q) => {
    const nRow = needleByIdx.get(q.index);
    const aRow = agentByIdx.get(q.index);
    return {
      ...q,
      discovery: nRow?.discovery ?? null,
      corpusNeedle: nRow?.corpusNeedle ?? null,
      corpusAgent: aRow?.corpusNeedle,
      agentDiscovery: aRow?.discovery,
      evidenceFile: nRow?.evidenceFile ?? aRow?.evidenceFile,
      providersNeedle: nRow?.providersNeedle ?? aRow?.providersNeedle ?? {},
    };
  });

  return {
    manifest,
    needleCompatible: summary(needle),
    agent: summary(agent),
    questions,
    diagnostics: needle?.diagnostics ?? [],
  };
}

async function readJsonOptional<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function loadRunIndex(): Promise<RunIndex> {
  const index = await readJsonOptional<RunIndex>(join(RUNS_DIR, "index.json")) ?? {
    updatedAt: new Date().toISOString(),
    startDate: "2026-11-22T00:00:00Z",
    runs: [],
  };
  index.runs = index.runs.filter((run) => !run.simulated);
  return index;
}

export async function loadCorpusWeeklyReport(): Promise<CorpusWeeklyReport | null> {
  return readJsonOptional<CorpusWeeklyReport>(join(process.cwd(), "data", "corpus-report.json"));
}

function isFullRun(run: RunIndexEntry) {
  return !run.slice && !run.sampleSize && !run.simulated;
}

export function latestFullRun(runs: RunIndexEntry[], vertical: VerticalId) {
  return runs.find((run) => run.vertical === vertical && isFullRun(run));
}

export function latestFullRunsBySuite(runs: RunIndexEntry[]) {
  // The published run index is ordered newest first.
  const latest = new Map<VerticalId, RunIndexEntry>();
  for (const run of runs) {
    if (isFullRun(run) && !latest.has(run.vertical)) latest.set(run.vertical, run);
  }
  return [...latest.values()];
}

export async function loadReportRunLinks(
  runs: RunIndexEntry[],
  weekly: CorpusWeeklyReport | null,
): Promise<ReportRunLink[]> {
  const fullRuns = runs.filter(isFullRun);
  const links = await Promise.all(benchmarkSuites.map(async (suite) => {
    const suiteRuns = fullRuns.filter((run) => run.vertical === suite);
    if (!suiteRuns.length) return null;
    const [needle, agent] = await Promise.all([
      loadLatestRunScore(suiteRuns, "needle", !weekly?.suites[suite]),
      loadLatestRunScore(suiteRuns, "agent", !weekly?.agent?.suites[suite]),
    ]);
    return { suite, href: `/runs/${suiteRuns[0].id}`, scores: { needle, agent } };
  }));
  return links.filter((link) => link !== null);
}

async function loadLatestRunScore(
  runs: RunIndexEntry[],
  mode: CorpusReportMode,
  includeBuckets: boolean,
): Promise<ReportRunScore | null> {
  for (const run of runs) {
    const agent = mode === "agent";
    const indexedNdcg = agent ? run.corpusAgentMeanNdcg : run.corpusNeedleMeanNdcg;
    const indexedRecall = agent ? run.corpusAgentRecallAtK : run.corpusNeedleRecallAtK;
    const path = agent ? run.agentPath : run.needleCompatiblePath;
    const missingIndexScore = indexedNdcg == null && indexedRecall == null;
    const needsBuckets = includeBuckets && indexedNdcg == null;
    const bundle = path && (missingIndexScore || needsBuckets) ? await loadRunBundle(run.id) : null;
    const artifact = agent ? bundle?.agent : bundle?.needleCompatible;
    const corpus = artifact?.providers.find((provider) => provider.isCorpus && provider.scored > 0);
    const ndcg = indexedNdcg ?? corpus?.meanNdcg;
    const recall = indexedRecall ?? corpus?.recallAtK;
    const retrieval = ndcg ?? recall;
    if (retrieval == null) continue;
    const ultimate = artifact?.ultimateRecallAtK ?? run.ultimateRecallAtK;
    const share = ndcg ?? (ultimate != null && ultimate > 0 ? retrieval / ultimate : null);
    const byBucket = needsBuckets && corpus ? Object.fromEntries(
      Object.entries(corpus.byBucket).flatMap(([bucket, { scored, recall }]) => scored > 0 ? [[bucket, recall]] : []),
    ) : undefined;
    return { retrieval, share, byBucket };
  }
  return null;
}

export async function loadRunBundle(runSlug: string): Promise<RunBundle | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(runSlug) || isLocalRunSlug(runSlug)) return null;
  return readRunBundle(join(RUNS_DIR, runSlug));
}

export async function loadLocalRunBundle(runSlug: string): Promise<RunBundle | null> {
  if (!isLocalRunSlug(runSlug)) return null;
  return readRunBundle(join(LOCAL_RUNS_DIR, runSlug));
}

async function readRunBundle(dir: string): Promise<RunBundle | null> {
  const [manifest, inputs, needle, agent] = await Promise.all([
    readJsonOptional<RunManifest>(join(dir, "manifest.json")),
    readJsonOptional<RunInputsArtifact>(join(dir, "inputs.json")),
    readJsonOptional<NeedleCompatibleArtifact>(join(dir, "needle-compatible.json")),
    readJsonOptional<NeedleCompatibleArtifact>(join(dir, "agent.json")),
  ]);
  if (!manifest || manifest.simulated || !inputs) return null;
  return assembleRunBundle(manifest, inputs, needle, agent);
}
