import { mkdir, mkdtemp, readFile, rename, rmdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isCheckpointSnapshot, CaseCheckpoints, retrievalFingerprint } from "../eve/checkpoints";
import { agentHarness, needleCompatibleHarness } from "../harnesses";
import { CorpusClient } from "./corpus-cli";
import { hasAgentProvider, hasGatewayApiKey } from "./gateway";
import { COMPARISON_VERSION, loadConfig, loadLedger, saveLedger } from "./refresh-plan";
import { publicRunJson } from "./public-run-json";
import { assembleRunBundle, buildCsv, LOCAL_RUNS_DIR } from "./runs";
import type {
  BenchConfig,
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

export async function executeRun(params: {
  upstream: ParsedBatch;
  sampleSize?: number;
  batchQueryCount?: number;
  harnesses?: RetrievalHarnessId[];
  skipLlm?: boolean;
  config?: BenchConfig;
}): Promise<RunBundle> {
  const { upstream } = params;
  const { runId: upstreamRunId, vertical } = upstream;
  const relevance = relevanceSuite(vertical);
  const config = { ...(params.config ?? await loadConfig()), searchK: upstream.k, snippetChars: upstream.snippetChars };
  const {
    sampleSize,
    harnesses = config.enabledHarnesses,
    skipLlm = false,
  } = params;

  if (relevance && harnesses.length && (skipLlm || !hasGatewayApiKey() || !upstream.judgeModel)) {
    throw new Error(`${vertical} requires the published judge model and AI_GATEWAY_API_KEY for Corpus relevance scoring.`);
  }
  if (harnesses.includes("agent") && (skipLlm || !hasAgentProvider())) {
    throw new Error("Corpus (Agent) requires AI_GATEWAY_API_KEY (or AGENT_PROVIDER=ollama) to run Eve.");
  }
  const runSlug = [upstreamRunId, vertical, sampleSize && `preview-${sampleSize}`].filter(Boolean).join("-");
  const localRun = sampleSize !== undefined;
  const runsDir = localRun ? LOCAL_RUNS_DIR : PUBLIC_RUNS_DIR;
  const runUrlBase = `/${localRun ? "local-runs" : "runs"}/${runSlug}`;
  const outDir = join(runsDir, runSlug);
  await mkdir(outDir, { recursive: true });

  const corpus = new CorpusClient(config.corpusRegistry);
  await corpus.ensureDaemonStarted();
  const cliVersion = await corpus.version();

  // Preserve any peer harness artifact already written for this run
  let needleArtifact = await readJsonOptional<NeedleCompatibleArtifact>(
    join(outDir, needleCompatibleHarness.artifactFilename),
  );
  let agentArtifact = await readJsonOptional<NeedleCompatibleArtifact>(join(outDir, agentHarness.artifactFilename));
  const otherMode = harnesses.length === 1
    ? harnesses[0] === "agent" ? needleArtifact : agentArtifact
    : null;
  const pairedMode = otherMode?.grading === "needle" && otherMode.discoveryMode === "eve" ? otherMode : null;
  const checkpointNamespace = process.env.BENCH_CHECKPOINT_NAMESPACE ?? await retrievalFingerprint();
  const caseCheckpoints = !skipLlm && hasAgentProvider()
    ? new CaseCheckpoints({
      namespace: checkpointNamespace,
      repo: config.upstreamRepo,
      runSlug,
      cliVersion,
      registry: config.corpusRegistry,
      index: config.corpusIndex,
      models: config.models,
      k: upstream.k,
      snippetChars: upstream.snippetChars,
      queryIds: upstream.queries.map(({ queryId }) => queryId),
    }) : undefined;
  const savedIndex = pairedMode ? null : await caseCheckpoints?.read("index");
  const indexPin = pairedMode?.indexSnapshot ?? (isCheckpointSnapshot(savedIndex) ? savedIndex : null);
  const indexSnapshot = indexPin
    ? await corpus.attachPinned(indexPin)
    : await corpus.attachAndInfo(config.corpusIndex);
  if (caseCheckpoints && !indexPin) await caseCheckpoints.save("index", indexSnapshot);
  const runTimestamp = new Date().toISOString();
  const stagingRoot = join(ROOT_DIR, ".evals", "scoring-inputs");
  await mkdir(stagingRoot, { recursive: true });
  const outputDir = await mkdtemp(join(stagingRoot, `${runSlug}-`));

  const harnessCtx = {
    config,
    upstream,
    outputDir,
    corpus,
    cliVersion,
    indexSnapshot,
    skipLlm,
    caseCheckpoints,
  };

  async function saveRetrieval(artifact: NeedleCompatibleArtifact, filename: string) {
    if (artifact.retrievalFile) {
      await rename(join(outputDir, artifact.retrievalFile), join(outDir, artifact.retrievalFile));
    }
    // Full Scholar batches can exceed GitHub's per-file limit. The viewer needs evidence for one question at a time.
    await mkdir(join(outDir, "evidence"), { recursive: true });
    const questions = [];
    for (const question of artifact.questions) {
      const results = { ...question.providersNeedle, [question.corpusNeedle.engine]: question.corpusNeedle };
      const file = `evidence/${question.index}.json`;
      const path = join(outDir, file);
      const previous = await readJsonOptional<Record<string, RankedEvidence[]>>(path);
      const evidence = Object.fromEntries(Object.entries(results).map(([engine, row]) => [engine, row.results]));
      await writeFile(path, publicRunJson({ ...previous, ...evidence }));
      const evidenceFile = `${runUrlBase}/${file}`;
      question.evidenceFile = evidenceFile;
      questions.push({
        ...question,
        evidenceFile,
        corpusNeedle: { ...question.corpusNeedle, results: [] },
        providersNeedle: Object.fromEntries(
          Object.entries(question.providersNeedle).map(([engine, row]) => [engine, { ...row, results: [] }]),
        ),
      });
    }
    await writeFile(join(outDir, filename), `${publicRunJson({ ...artifact, questions }, 2)}\n`, "utf8");
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
  await rmdir(outputDir);

  // Merge resolved corpora from whichever harnesses ran
  const resolvedCorpora: Record<string, CorpusSnapshotRef> = {
    ...(needleArtifact?.resolvedCorpora ?? {}),
    ...(agentArtifact?.resolvedCorpora ?? {}),
  };

  const inputsArtifact: RunInputsArtifact = {
    upstreamRunId,
    upstreamUrl: upstream.upstreamUrl,
    upstreamRunDate: upstream.runDateIso,
    vertical,
    slice: null,
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
    ...(artifact?.retrievalFile ? { retrieval: `${runUrlBase}/${artifact.retrievalFile}` } : {}),
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
    slice: null,
    ...(sampleSize ? { sampleSize } : {}),
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
    },
    files: {
      manifest: `${runUrlBase}/manifest.json`,
      inputs: `${runUrlBase}/inputs.json`,
      needleCompatible: `${runUrlBase}/${needleCompatibleHarness.artifactFilename}`,
      ...(agentManifest ? { agent: agentManifest.artifact } : {}),
      scoresCsv: `${runUrlBase}/scores.csv`,
    },
  };

  await Promise.all([
    writeFile(join(outDir, "manifest.json"), `${publicRunJson(manifest, 2)}\n`, "utf8"),
    writeFile(join(outDir, "inputs.json"), `${publicRunJson(inputsArtifact, 2)}\n`, "utf8"),
    writeFile(join(outDir, "scores.csv"), buildCsv(needleArtifact, agentArtifact), "utf8"),
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
  const corpusAgentRow = agentArtifact?.providers.find((p) => p.isCorpus) ?? null;
  const discoverySource = needleArtifact ?? agentArtifact;
  const discoveryRate =
    discoverySource && discoverySource.questions.length > 0
      ? discoverySource.questions.filter((q) => q.discovery.status === "found").length /
        discoverySource.questions.length
      : null;

  const entry: RunIndexEntry = {
    id: runSlug,
    upstreamRunId,
    vertical,
    slice: null,
    ...(sampleSize ? { sampleSize, batchQueryCount: params.batchQueryCount } : {}),
    queryCount: upstream.queries.length,
    upstreamRunDate: upstream.runDateIso,
    corpusRunDate: runTimestamp,
    corpusCliVersion: cliVersion,
    ...(relevance ? { corpusNeedleMeanNdcg: corpusNeedleRow?.meanNdcg ?? null } : {}),
    corpusNeedleRecallAtK: !relevance && corpusNeedleRow ? corpusNeedleRow.recallAtK : null,
    corpusNeedleMrrAtK: !relevance && corpusNeedleRow ? corpusNeedleRow.mrrAtK : null,
    ...(agentArtifact
      ? relevance
        ? { corpusAgentMeanNdcg: corpusAgentRow?.meanNdcg ?? null }
        : { corpusAgentRecallAtK: corpusAgentRow?.recallAtK ?? null }
      : {}),
    ultimateRecallAtK: !relevance ? (needleArtifact ?? agentArtifact)?.ultimateRecallAtK ?? null : null,
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
    slice: null,
    outputDir: `public/runs/${runSlug}`,
    harnesses: harnessRecords,
  };
  await saveLedger(ledger);

  return bundle;
}
