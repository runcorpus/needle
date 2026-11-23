import { benchmarkSuites, type CorpusWeeklyReport } from "./corpus-report";
import type { PublishedReport, ReportTab } from "./published-report";
import type { RunIndexEntry, VerticalId } from "./types";

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

export interface ReportRunLink {
  suite: VerticalId;
  href: string;
  retrieval: number | null;
  share: number | null;
  simulated: boolean;
  byBucket?: Record<string, number>;
}

export function reportRunLink(run: RunIndexEntry): ReportRunLink {
  const recall = run.corpusNeedleRecallAtK;
  const ndcg = run.corpusNeedleMeanNdcg;
  const ultimate = run.ultimateRecallAtK;
  return {
    suite: run.vertical,
    href: `/runs/${run.id}`,
    retrieval: ndcg ?? recall,
    share: ndcg ?? (recall != null && ultimate != null && ultimate > 0 ? recall / ultimate : null),
    simulated: run.simulated === true,
  };
}

export function reportPercent(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 100).toString().replace("-", "−")}%`;
}

export function latestOverall(runs: ReportRunLink[]) {
  const scores = runs.flatMap(({ share }) => share == null ? [] : [share]);
  return scores.length === benchmarkSuites.length
    ? scores.reduce((sum, share) => sum + share, 0) / scores.length
    : null;
}

export function reportStandings(report: PublishedReport, runs: ReportRunLink[], weekly: CorpusWeeklyReport | null) {
  const measured = benchmarkSuites.some((suite) => weekly?.suites[suite]);
  function shares(suites: CorpusWeeklyReport["suites"] | undefined) {
    return benchmarkSuites.map((suite) => {
      const aggregate = suites?.[suite];
      return aggregate && aggregate.ultimate > 0 ? aggregate.score.mean / aggregate.ultimate : null;
    });
  }

  return {
    measured,
    rows: [
      { engine: corpusAgent, overall: weekly?.agent?.overall?.mean ?? null, shares: shares(weekly?.agent?.suites) },
      {
        engine: corpusNeedle,
        overall: measured ? weekly?.overall?.mean ?? null : latestOverall(runs),
        shares: measured ? shares(weekly?.suites) : benchmarkSuites.map((suite) => runs.find((run) => run.suite === suite)?.share ?? null),
      },
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
  const fallback = tab === "overall" ? reportPercent(latestOverall(runs)) : run?.retrieval?.toFixed(3) ?? "—";
  const needleSuite = tab === "overall" ? undefined : weekly?.suites[tab];
  const agentSuite = tab === "overall" ? undefined : weekly?.agent?.suites[tab];
  const measured = tab === "overall" ? weekly?.overall : needleSuite?.score;
  const agentMeasured = tab === "overall" ? weekly?.agent?.overall : agentSuite?.score;
  const format = (value: number) => tab === "overall" ? `${(value * 100).toFixed(1)}%` : value.toFixed(3);
  const formatScore = (value: number) => tab === "overall" ? reportPercent(value) : format(value);
  const scores = [
    { engine: corpusAgent, measured: agentMeasured, fallback: "—", byBucket: agentSuite?.byBucket },
    { engine: corpusNeedle, measured, fallback, byBucket: needleSuite ? needleSuite.byBucket : run?.byBucket },
  ];
  return scores.map(({ engine, measured, fallback, byBucket }) => {
    const score = measured ? formatScore(measured.mean) : fallback;
    const interval = measured?.interval ? `[${measured.interval.map(format).join(", ")}]` : "—";
    const values = columns.slice(1).map((heading, index) => {
      if (index === 0) return score;
      if (heading === "95% CI") return interval;
      const bucket = byBucket?.[heading.toLowerCase()];
      return bucket == null ? "—" : format(bucket);
    });
    return [engine, ...values];
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
