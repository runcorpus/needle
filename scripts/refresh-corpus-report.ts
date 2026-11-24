import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  aggregateCorpusWeek, percentile,
  type CorpusWeeklyReport, type CorpusWeeklyStats, type MeasuredBatch,
} from "../src/lib/corpus-report";
import { LOCAL_RUNS_DIR, loadLocalRunBundle, loadRunBundle, loadRunIndex } from "../src/lib/runs";
import type { ProviderQueryResult, QuestionComparison, RunIndex } from "../src/lib/types";
import { relevanceSuite } from "../src/lib/upstream";

const local = process.argv.includes("--local");
const output = local ? join(LOCAL_RUNS_DIR, "corpus-report.json") : "data/corpus-report.json";
const now = new Date();
const weekStart = now.getTime() - 7 * 24 * 60 * 60 * 1000;
const { runs } = local
  ? JSON.parse(await readFile(join(LOCAL_RUNS_DIR, "index.json"), "utf8").catch(() => '{"runs":[]}')) as RunIndex
  : await loadRunIndex();
const loadBundle = local ? loadLocalRunBundle : loadRunBundle;
const batches = { needle: [] as MeasuredBatch[], agent: [] as MeasuredBatch[] };
const latency = { needle: { search: [] as number[], agent: [] as number[] }, agent: { search: [] as number[], agent: [] as number[] } };

function score(result: ProviderQueryResult | null | undefined, relevance: boolean) {
  if (!result || result.unscoredReason) return null;
  if (relevance) return typeof result.ndcg === "number" && Number.isFinite(result.ndcg) ? result.ndcg : null;
  return result.hitRank == null ? 0 : 1;
}

for (const run of runs) {
  if (run.simulated || run.slice) continue;
  if (!local && run.sampleSize) continue;
  const date = Date.parse(run.upstreamRunDate);
  if (!Number.isFinite(date) || date < weekStart || date > now.getTime()) continue;
  const bundle = await loadBundle(run.id);
  if (!bundle) continue;
  const relevance = relevanceSuite(run.vertical);
  function collect(variant: keyof typeof batches, key: keyof Pick<QuestionComparison, "corpusNeedle" | "corpusAgent">, questions: QuestionComparison[]) {
    const batch: MeasuredBatch = { id: run.id, suite: run.vertical, questions: [] };
    for (const question of questions) {
      const result = question[key];
      const measured = score(result, relevance);
      const ultimate = score(question.providersNeedle.ultimate, relevance);
      if (measured !== null && ultimate !== null) {
        batch.questions.push({ queryId: question.queryId, bucket: question.bucket, score: measured, ultimate });
      }
      const timing = result?.timing;
      if (!timing) continue;
      if (Number.isFinite(timing.agentMs) && timing.agentMs > 0) latency[variant].agent.push(timing.agentMs);
      for (const ms of timing.searchMs) if (Number.isFinite(ms) && ms > 0) latency[variant].search.push(ms);
    }
    if (batch.questions.length) batches[variant].push(batch);
  }
  if (bundle.needleCompatible?.discoveryMode === "eve" && bundle.needleCompatible.grading === "needle") {
    collect("needle", "corpusNeedle", bundle.questions);
  }
  if (bundle.agent?.discoveryMode === "eve" && bundle.agent.grading === "needle") {
    collect("agent", "corpusAgent", bundle.questions);
  }
}

function timings(values: number[]): [number, number] | null {
  return values.length ? [percentile(values, 0.50), percentile(values, 0.95)] : null;
}

function stats(variant: keyof typeof batches): CorpusWeeklyStats {
  return {
    ...aggregateCorpusWeek(batches[variant]),
    latency: { search: timings(latency[variant].search), agent: timings(latency[variant].agent) },
  };
}

const report: CorpusWeeklyReport = {
  windowEnd: now.toISOString(),
  ...stats("needle"),
  ...(batches.agent.length || latency.agent.agent.length ? { agent: stats("agent") } : {}),
};
const priorText = await readFile(output, "utf8").catch(() => null);
const prior = priorText ? JSON.parse(priorText) as CorpusWeeklyReport : null;
if (!prior || JSON.stringify({ ...prior, windowEnd: report.windowEnd }) !== JSON.stringify(report)) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  await rename(`${output}.tmp`, output);
}
console.log(`Saved ${local ? "local " : ""}Corpus 7-day aggregates from ${batches.needle.length} measured NEEDLE batches and ${batches.agent.length} measured Agent batches to ${output}.`);
