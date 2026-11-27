import { benchmarkSuites, measuredOverall, overallSuiteMean, type CorpusWeeklyReport, type CorpusWeeklyStats } from "./corpus-report";
import type { PublishedReport, ReportTab } from "./published-report";
import type { VerticalId } from "./types";

export const corpusAgent = "Corpus (Agent)";
export const corpusNeedle = "Corpus (NEEDLE)";
export const reportLabels: Record<ReportTab, string> = {
  overall: "Overall",
  scholar: "Scholar",
  news: "News",
  finance: "Finance",
  agentic_rare: "AgenticRare",
  legal: "Legal",
};

const corpusModes = ["agent", "needle"] as const;
export type CorpusReportMode = typeof corpusModes[number];
const corpusLabels = { agent: corpusAgent, needle: corpusNeedle };

export interface ReportRunScore {
  retrieval: number;
  share: number | null;
  byBucket?: Record<string, number>;
}

export interface ReportRunLink {
  suite: VerticalId;
  href: string;
  localQueryCount?: number;
  scores: Record<CorpusReportMode, ReportRunScore | null>;
}

export function reportPercent(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 100).toString().replace("-", "−")}%`;
}

function weeklyStats(weekly: CorpusWeeklyReport | null, mode: CorpusReportMode) {
  return mode === "agent" ? weekly?.agent : weekly;
}

function overallScore(runs: ReportRunLink[], mode: CorpusReportMode, stats: CorpusWeeklyStats | null | undefined) {
  if (stats) return { mean: measuredOverall(stats.suites).mean, interval: stats.overall?.interval ?? null };
  const shares = benchmarkSuites.map((suite) => runs.find((run) => run.suite === suite)?.scores[mode]?.share);
  return { mean: overallSuiteMean(shares), interval: null };
}

export function reportStandings(report: PublishedReport, runs: ReportRunLink[], weekly: CorpusWeeklyReport | null) {
  const measured = benchmarkSuites.some((suite) => weekly?.suites[suite]);
  return {
    measured,
    rows: [
      ...corpusModes.map((mode) => {
        const stats = weeklyStats(weekly, mode);
        const shares = benchmarkSuites.map((suite) => {
          const aggregate = stats?.suites[suite];
          if (aggregate && aggregate.ultimate > 0) return aggregate.score.mean / aggregate.ultimate;
          return runs.find((run) => run.suite === suite)?.scores[mode]?.share ?? null;
        });
        const overall = overallScore(runs, mode, stats);
        return { engine: corpusLabels[mode], overall: overall.mean, shares };
      }),
      ...report.standings,
    ],
  };
}

export function reportCorpusRows(
  tab: ReportTab,
  columns: string[],
  runs: ReportRunLink[],
  weekly: CorpusWeeklyReport | null,
) {
  const run = runs.find(({ suite }) => suite === tab);
  const format = (value: number) => tab === "overall" ? `${(value * 100).toFixed(1)}%` : value.toFixed(3);
  return corpusModes.map((mode) => {
    const stats = weeklyStats(weekly, mode);
    const aggregate = tab === "overall" ? undefined : stats?.suites[tab];
    const fallback = run?.scores[mode];
    const score = tab === "overall" ? overallScore(runs, mode, stats) : aggregate?.score;
    const metric = tab === "overall" ? reportPercent(score?.mean ?? null)
      : (aggregate?.score.mean ?? fallback?.retrieval)?.toFixed(3) ?? "—";
    const interval = score?.interval ? `[${score.interval.map(format).join(", ")}]` : "—";
    const byBucket = aggregate?.byBucket ?? fallback?.byBucket;
    const values = columns.slice(1).map((heading, index) => {
      if (index === 0) return metric;
      if (heading === "95% CI") return interval;
      const bucket = byBucket?.[heading.toLowerCase()];
      return bucket == null ? "—" : format(bucket);
    });
    return [corpusLabels[mode], ...values];
  });
}

export function reportLatency(report: PublishedReport, weekly: CorpusWeeklyReport | null) {
  function label(ms: number) {
    return ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`;
  }
  const variants = [
    { engine: corpusAgent, timing: weekly?.agent?.latency.search },
    { engine: corpusNeedle, timing: weekly?.latency.search },
  ];
  const corpusRows = variants.map(({ engine, timing }) => {
    if (!timing) return { engine };
    const [p50, p95] = timing;
    return { engine, p50, p95, p50Label: label(p50), p95Label: label(p95) };
  });
  return [...corpusRows, ...[...report.latency].sort((a, b) => a.p50 - b.p50)];
}
