import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentHarness, needleCompatibleHarness } from "../harnesses";
import { CorpusClient } from "./corpus-cli";
import { hasGatewayApiKey } from "./gateway";
import { COMPARISON_VERSION, loadConfig, loadLedger, saveLedger } from "./refresh-plan";
import { publicRunJson } from "./public-run-json";
import { assembleRunBundle, LOCAL_RUNS_DIR } from "./runs";
import type {
  BenchConfig,
  CorpusQACompatibleArtifact,
  CorpusSnapshotRef,
  NeedleCompatibleArtifact,
  RankedEvidence,
  RetrievalHarnessId,
  RunBundle,
  RunIndex,
  RunIndexEntry,
  RunInputsArtifact,
  RunManifest,
} from "./types";
import { relevanceSuite, type ParsedBatch } from "./upstream";

const ROOT_DIR = process.cwd();
const PUBLIC_RUNS_DIR = join(ROOT_DIR, "public", "runs");

async function readJsonOptional<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function buildCsv(
  needle: NeedleCompatibleArtifact | null,
  agent: NeedleCompatibleArtifact | null,
  corpusqa: CorpusQACompatibleArtifact | null,
): string {
  const headers = [
    "harness",
    "engine",
    "display_name",
    "primary_score",
    "secondary_score",
    "pct_of_ultimate",
    "hits_or_correct",
    "scored_or_total",
    "tested_at",
  ];
  const rows: string[][] = [headers];

  if (corpusqa) {
    for (const p of corpusqa.providers) {
      rows.push([
        "corpusqa-compatible",
        p.engine,
        p.displayName,
        p.accuracy.toFixed(4),
        "",
        "",
        String(p.correct),
        String(p.total),
        p.testedAt ?? "",
      ]);
    }
  }
  for (const artifact of [needle, agent]) {
    if (!artifact) continue;
    for (const p of artifact.providers) {
      if (artifact === agent && needle && !p.isCorpus) continue;
      rows.push([
        artifact.harness,
        p.engine,
        p.displayName,
        (p.meanNdcg ?? p.recallAtK)?.toFixed(4) ?? "",
        p.mrrAtK?.toFixed(4) ?? "",
        p.meanNdcg === undefined && p.pctOfUltimate !== null ? p.pctOfUltimate.toFixed(4) : "",
        p.meanNdcg === undefined ? String(p.hits) : "",
        String(p.scored),
        p.testedAt ?? "",
      ]);
    }
  }

  return `${rows.map((r) => r.map((v) => `"${v.replaceAll('"', '""')}"`).join(",")).join("\n")}\n`;
}

export async function executeRun(params: {
  upstream: ParsedBatch;
  slice: string | null;
  sampleSize?: number;
  simulateMisses?: boolean;
  harnesses?: RetrievalHarnessId[];
  skipLlm?: boolean;
  config?: BenchConfig;
}): Promise<RunBundle> {
  const { upstream } = params;
  const { runId: upstreamRunId, vertical } = upstream;
  const relevance = relevanceSuite(vertical);
  const config = { ...(params.config ?? await loadConfig()), searchK: upstream.k, snippetChars: upstream.snippetChars };
  const {
    slice,
    sampleSize,
    simulateMisses = false,
    harnesses = config.enabledHarnesses,
    skipLlm = false,
  } = params;

  if (!simulateMisses && relevance && harnesses.length && (skipLlm || !process.env.AI_GATEWAY_API_KEY?.trim() || !upstream.judgeModel)) {
    throw new Error(`${vertical} requires the published judge model and AI_GATEWAY_API_KEY for Corpus relevance scoring.`);
  }
  if (!simulateMisses && harnesses.includes("agent") && (skipLlm || !hasGatewayApiKey())) {
    throw new Error("Corpus (Agent) requires AI_GATEWAY_API_KEY to run Eve.");
  }
  const runSlug = [upstreamRunId, vertical, slice, sampleSize && `preview-${sampleSize}`, simulateMisses && "simulated"].filter(Boolean).join("-");
  const localRun = simulateMisses || sampleSize !== undefined;
  const runsDir = localRun ? LOCAL_RUNS_DIR : PUBLIC_RUNS_DIR;
  const runUrlBase = `/${localRun ? "local-runs" : "runs"}/${runSlug}`;
  const outDir = join(runsDir, runSlug);
  await mkdir(outDir, { recursive: true });

  const corpus = new CorpusClient(config.corpusRegistry);
  const publishedIndex = simulateMisses ? await readJsonOptional<RunIndex>(join(PUBLIC_RUNS_DIR, "index.json")) : null;
  const referenceId = publishedIndex?.runs[0]?.id;
  const reference = referenceId ? await readJsonOptional<RunManifest>(join(PUBLIC_RUNS_DIR, referenceId, "manifest.json")) : null;
  if (!reference) await corpus.ensureDaemonStarted();
  const cliVersion = reference?.corpus.cliVersion ?? await corpus.version();

  // Preserve any peer harness artifact already written for this run
  let needleArtifact = await readJsonOptional<NeedleCompatibleArtifact>(
    join(outDir, needleCompatibleHarness.artifactFilename),
  );
  let agentArtifact = await readJsonOptional<NeedleCompatibleArtifact>(join(outDir, agentHarness.artifactFilename));
  const corpusqaArtifact = await readJsonOptional<CorpusQACompatibleArtifact>(join(outDir, "corpusqa-compatible.json"));
  const otherMode = harnesses.length === 1 && !simulateMisses
    ? harnesses[0] === "agent" ? needleArtifact : agentArtifact
    : null;
  const pairedMode = otherMode?.grading === "needle" && otherMode.discoveryMode === "eve" ? otherMode : null;
  const indexSnapshot = reference?.corpus.indexSnapshot ?? (pairedMode
    ? await corpus.attachPinned(pairedMode.indexSnapshot)
    : await corpus.attachAndInfo(config.corpusIndex));
  const runTimestamp = new Date().toISOString();

  const harnessCtx = {
    config,
    upstream,
    slice,
    corpus,
    cliVersion,
    indexSnapshot,
    skipLlm,
    simulateMisses,
  };

  async function saveRetrieval(artifact: NeedleCompatibleArtifact, filename: string) {
    if (!slice) {
      // Full Scholar batches can exceed GitHub's per-file limit. The viewer needs evidence for one question at a time.
      await mkdir(join(outDir, "evidence"), { recursive: true });
      for (const question of artifact.questions) {
        const results = { ...question.providersNeedle, [question.corpusNeedle.engine]: question.corpusNeedle };
        const file = `evidence/${question.index}.json`;
        const path = join(outDir, file);
        const previous = await readJsonOptional<Record<string, RankedEvidence[]>>(path);
        const evidence = Object.fromEntries(Object.entries(results).map(([engine, row]) => [engine, row.results]));
        await writeFile(path, publicRunJson({ ...previous, ...evidence }));
        question.evidenceFile = `${runUrlBase}/${file}`;
        for (const row of Object.values(results)) row.results = [];
      }
    }
    await writeFile(join(outDir, filename), `${publicRunJson(artifact, 2)}\n`, "utf8");
  }

  if (harnesses.includes("needle-compatible")) {
    needleArtifact = await needleCompatibleHarness.run({ ...harnessCtx, pinnedCorpora: pairedMode?.resolvedCorpora });
  }
  if (harnesses.includes("agent")) {
    const pinnedCorpora = harnesses.includes("needle-compatible") ? needleArtifact?.resolvedCorpora : pairedMode?.resolvedCorpora;
    agentArtifact = await agentHarness.run({ ...harnessCtx, pinnedCorpora });
  }
  if (needleArtifact && harnesses.includes("needle-compatible")) {
    await saveRetrieval(needleArtifact, needleCompatibleHarness.artifactFilename);
  }
  if (agentArtifact && harnesses.includes("agent")) {
    await saveRetrieval(agentArtifact, agentHarness.artifactFilename);
  }

  // Merge resolved corpora from whichever harnesses ran
  const resolvedCorpora: Record<string, CorpusSnapshotRef> = {
    ...(corpusqaArtifact?.resolvedCorpora ?? {}),
    ...(needleArtifact?.resolvedCorpora ?? {}),
    ...(agentArtifact?.resolvedCorpora ?? {}),
  };

  const inputsArtifact: RunInputsArtifact = {
    upstreamRunId,
    upstreamUrl: upstream.upstreamUrl,
    upstreamRunDate: upstream.runDateIso,
    vertical,
    slice,
    queries: upstream.queries,
  };
  const retrievalManifest = (artifact: NeedleCompatibleArtifact | null, filename: string) => ({
    status: artifact?.status ?? ("not_run" as const),
    executedAt: artifact?.executedAt ?? null,
    discoveryMode: artifact?.discoveryMode ?? null,
    discoveryModel: artifact?.discoveryModel ?? null,
    primaryMetric: relevance ? `nDCG@${upstream.k}` : `Recall@${config.searchK}`,
    secondaryMetric: relevance ? "" : `MRR@${config.searchK}`,
    artifact: `${runUrlBase}/${filename}`,
  });
  const agentManifest = agentArtifact ? retrievalManifest(agentArtifact, agentHarness.artifactFilename) : undefined;

  const manifest: RunManifest = {
    id: runSlug,
    upstreamRunId,
    upstreamUrl: upstream.upstreamUrl,
    upstreamCodeUrl: `https://github.com/${config.upstreamCodeRepo}`,
    upstreamRunDate: upstream.runDateIso,
    corpusRunDate: runTimestamp,
    vertical,
    slice,
    ...(sampleSize ? { sampleSize } : {}),
    ...(simulateMisses ? { simulated: true } : {}),
    queryCount: upstream.queries.length,
    k: config.searchK,
    snippetChars: config.snippetChars,
    corpus: {
      cliVersion,
      registry: config.corpusRegistry,
      indexRef: config.corpusIndex,
      indexSnapshot,
      resolvedCorpora,
    },
    harnesses: {
      "needle-compatible": retrievalManifest(needleArtifact, needleCompatibleHarness.artifactFilename),
      ...(agentManifest ? { agent: agentManifest } : {}),
      ...(corpusqaArtifact ? { "corpusqa-compatible": {
        status: corpusqaArtifact.status,
        executedAt: corpusqaArtifact.executedAt,
        agentModel: corpusqaArtifact.agentModel,
        judgeModel: corpusqaArtifact.judgeModel,
        zeroDataRetention: corpusqaArtifact.zeroDataRetention,
        rubric: corpusqaArtifact.rubric,
        comparedProviders: corpusqaArtifact.comparedProviders,
        artifact: `${runUrlBase}/corpusqa-compatible.json`,
      } } : {}),
    },
    files: {
      manifest: `${runUrlBase}/manifest.json`,
      inputs: `${runUrlBase}/inputs.json`,
      needleCompatible: `${runUrlBase}/${needleCompatibleHarness.artifactFilename}`,
      ...(agentManifest ? { agent: agentManifest.artifact } : {}),
      ...(corpusqaArtifact ? { corpusqaCompatible: `${runUrlBase}/corpusqa-compatible.json` } : {}),
      scoresCsv: `${runUrlBase}/scores.csv`,
    },
  };

  await Promise.all([
    writeFile(join(outDir, "manifest.json"), `${publicRunJson(manifest, 2)}\n`, "utf8"),
    writeFile(join(outDir, "inputs.json"), `${publicRunJson(inputsArtifact, 2)}\n`, "utf8"),
    writeFile(join(outDir, "scores.csv"), buildCsv(needleArtifact, agentArtifact, corpusqaArtifact), "utf8"),
    // Clean up legacy combined results.json if present
    rm(join(outDir, "results.json"), { force: true }),
  ]);

  // Update the index alongside the artifacts.
  let currentIndex: RunIndex = { updatedAt: runTimestamp, startDate: config.startDate, runs: [] };
  try {
    currentIndex = JSON.parse(await readFile(join(runsDir, "index.json"), "utf8")) as RunIndex;
  } catch {
    // first run
  }

  const corpusNeedleRow = needleArtifact?.providers.find((p) => p.isCorpus) ?? null;
  const corpusQaRow = corpusqaArtifact?.providers.find((p) => p.isCorpus) ?? null;
  const qaRetrievalScores = corpusqaArtifact?.questions.flatMap(({ retrieval }) => {
    if (!retrieval || retrieval.unscoredReason) return [];
    if (relevance) return retrieval.ndcg == null ? [] : [retrieval.ndcg];
    return [Number(retrieval.detRank !== null)];
  }) ?? [];
  const discoveryRate =
    needleArtifact && needleArtifact.questions.length > 0
      ? needleArtifact.questions.filter((q) => q.discovery.status === "found").length /
        needleArtifact.questions.length
      : null;

  const entry: RunIndexEntry = {
    id: runSlug,
    upstreamRunId,
    vertical,
    slice,
    ...(sampleSize ? { sampleSize } : {}),
    ...(simulateMisses ? { simulated: true } : {}),
    queryCount: upstream.queries.length,
    upstreamRunDate: upstream.runDateIso,
    corpusRunDate: runTimestamp,
    corpusCliVersion: cliVersion,
    ...(relevance ? { corpusNeedleMeanNdcg: corpusNeedleRow?.meanNdcg ?? null } : {}),
    corpusNeedleRecallAtK: !relevance && corpusNeedleRow ? corpusNeedleRow.recallAtK : null,
    corpusNeedleMrrAtK: !relevance && corpusNeedleRow ? corpusNeedleRow.mrrAtK : null,
    ultimateRecallAtK: !relevance ? (needleArtifact ?? agentArtifact)?.ultimateRecallAtK ?? null : null,
    ...(corpusqaArtifact ? {
      corpusqaStatus: corpusqaArtifact.status,
      corpusqaAccuracy: corpusQaRow?.accuracy ?? null,
      corpusqaRetrieval: qaRetrievalScores.length
        ? qaRetrievalScores.reduce((sum, score) => sum + score, 0) / qaRetrievalScores.length
        : null,
      corpusqaCompatiblePath: manifest.files.corpusqaCompatible,
    } : {}),
    discoveryRate,
    manifestPath: manifest.files.manifest,
    needleCompatiblePath: manifest.files.needleCompatible,
    ...(agentManifest ? { agentPath: agentManifest.artifact } : {}),
  };

  const nextRuns = [entry, ...currentIndex.runs.filter((r) => r.id !== entry.id)].sort(
    (a, b) => Date.parse(b.upstreamRunDate) - Date.parse(a.upstreamRunDate),
  );

  await writeFile(
    join(runsDir, "index.json"),
    `${JSON.stringify({ updatedAt: runTimestamp, startDate: config.startDate, runs: nextRuns }, null, 2)}\n`,
    "utf8",
  );

  console.log(`[needle] Saved per-harness artifacts to ${outDir}`);
  const bundle = assembleRunBundle(manifest, inputsArtifact, needleArtifact, agentArtifact);
  if (localRun) return bundle;

  // Update per-harness ledger for measured runs.
  const ledger = await loadLedger();
  const prevEntry = ledger.processed[runSlug];
  const harnessRecords = { ...prevEntry?.harnesses };
  for (const artifact of [needleArtifact, agentArtifact]) {
    if (!artifact || !harnesses.includes(artifact.harness)) continue;
    harnessRecords[artifact.harness] = {
      status: artifact.status,
      executedAt: artifact.executedAt,
      artifactFile: `${artifact.harness}.json`,
      corpusVersion: artifact.corpusCliVersion,
      corpusIndexSha256: artifact.indexSnapshot.id,
      ...(artifact.grading === "needle" && artifact.discoveryMode === "eve" ? { comparisonVersion: COMPARISON_VERSION } : {}),
    };
  }
  ledger.version = 2;
  ledger.processed[runSlug] = {
    runId: upstreamRunId,
    vertical,
    slice,
    outputDir: `public/runs/${runSlug}`,
    harnesses: harnessRecords,
  };
  await saveLedger(ledger);

  return bundle;
}
