import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { benchmarkSuites, type CorpusWeeklyReport } from "./corpus-report";
import { reportRunLink } from "./report-results";
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
  return /^[\w.-]+-(?:preview-[1-9]\d*|simulated)$/.test(runSlug);
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
  if (process.env.NODE_ENV !== "development") return index;
  const local = await readJsonOptional<RunIndex>(join(LOCAL_RUNS_DIR, "index.json"));
  return local ? { ...index, runs: [...index.runs, ...local.runs] } : index;
}

export function loadCorpusWeeklyReport(): Promise<CorpusWeeklyReport | null> {
  return readJsonOptional<CorpusWeeklyReport>(join(process.cwd(), "data", "corpus-report.json"));
}

export function latestFullRun(runs: RunIndexEntry[], vertical: VerticalId) {
  return runs.find((run) => run.vertical === vertical && !run.slice && !run.sampleSize && !run.simulated);
}

export async function loadReportRunLinks(
  runs: RunIndexEntry[],
  weekly: CorpusWeeklyReport | null,
  includeSimulated = false,
) {
  const links = await Promise.all(benchmarkSuites.map(async (suite) => {
    const run = latestFullRun(runs, suite) ?? (includeSimulated
      ? runs.find((entry) => entry.vertical === suite && entry.simulated && !entry.slice && !entry.sampleSize)
      : undefined);
    if (!run) return null;
    const link = reportRunLink(run);
    if (run.simulated || weekly?.suites[suite] || run.corpusNeedleRecallAtK == null) return link;

    const bundle = await loadRunBundle(run.id);
    const buckets = bundle?.needleCompatible?.providers.find((provider) => provider.isCorpus)?.byBucket ?? {};
    return {
      ...link,
      byBucket: Object.fromEntries(Object.entries(buckets).flatMap(([bucket, { scored, recall }]) =>
        scored > 0 ? [[bucket, recall]] : [],
      )),
    };
  }));
  return links.filter((link) => link !== null);
}

export async function loadRunBundle(runSlug: string): Promise<RunBundle | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(runSlug)) return null;
  const local = isLocalRunSlug(runSlug);
  if (local && process.env.NODE_ENV !== "development") return null;
  const dir = join(local ? LOCAL_RUNS_DIR : RUNS_DIR, runSlug);
  const [manifest, inputs, needle, agent] = await Promise.all([
    readJsonOptional<RunManifest>(join(dir, "manifest.json")),
    readJsonOptional<RunInputsArtifact>(join(dir, "inputs.json")),
    readJsonOptional<NeedleCompatibleArtifact>(join(dir, "needle-compatible.json")),
    readJsonOptional<NeedleCompatibleArtifact>(join(dir, "agent.json")),
  ]);
  if (!manifest || !inputs) return null;
  return assembleRunBundle(manifest, inputs, needle, agent);
}
