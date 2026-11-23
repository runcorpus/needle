import { benchmarkSuites, type CorpusWeeklyReport } from "./corpus-report";
import { reportTabs, type PublishedReport } from "./published-report";
import { reportCorpusRows, reportLabels, reportLatency, reportPercent, reportStandings, type ReportRunLink } from "./report-results";
import type { RunIndexEntry } from "./types";

const site = "https://needle.corpusd.dev";
const dateUtc = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  dateStyle: "medium",
  timeStyle: "short",
});

function markdownTable(columns: string[], rows: string[][]) {
  function line(cells: string[]) {
    return `| ${cells.map((cell) => (cell || "—").replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\s+/g, " ")).join(" | ")} |`;
  }
  return [line(columns), line(columns.map((_, index) => index === 0 ? "---" : "---:")), ...rows.map(line)].join("\n");
}

export function renderResultsMarkdown(report: PublishedReport, runs: RunIndexEntry[], weekly: CorpusWeeklyReport | null, runLinks: ReportRunLink[]) {
  const fullRuns = runs.filter((run) => !run.slice && !run.sampleSize && !run.simulated);
  const latest = fullRuns[0];
  const standings = reportStandings(report, runLinks, weekly).rows;
  const sections = [
    "# Corpus NEEDLE Benchmark",
    `[Interactive report](${site}/) · [Original NEEDLE](https://keenableai.github.io/needle/)`,
    latest ? `Latest full batch · ${dateUtc.format(new Date(latest.upstreamRunDate))} UTC` : "Full batches pending",
    `NEEDLE provider data through ${report.sourceUpdated}`,
    "Corpus (NEEDLE) searches with the original question. Corpus (Agent) can rewrite queries. Both submit ranked URLs at the published retrieval depth and use the same NEEDLE evaluator.",
    "## Standings across all suites",
    "Scores are shown as a share of Ultimate, NEEDLE’s pooled ceiling across providers.",
    markdownTable(
      ["Engine", "Of Ultimate", ...benchmarkSuites.map((suite) => reportLabels[suite])],
      standings.map(({ engine, overall, shares }) => [engine, reportPercent(overall), ...shares.map(reportPercent)]),
    ),
    "## 7-day leaderboards",
    "Corpus uses measured full batches, with the latest saved full run as a fallback. Provider scores and confidence intervals come from NEEDLE.",
  ];

  for (const tab of reportTabs) {
    const { caption, columns, rows } = report.leaderboards[tab];
    const ultimate = rows.find(([engine]) => engine === "ultimate");
    const suite = tab === "overall" ? undefined : weekly?.suites[tab];
    const run = runLinks.find(({ suite }) => suite === tab);
    const href = suite ? `/runs/${suite.latestRunId}` : run?.href;
    sections.push(`### ${reportLabels[tab]}`, caption);
    if (href) sections.push(`[View ${reportLabels[tab]} run](${site}${href})`);
    sections.push(markdownTable(columns, [
      ...(ultimate ? [["Ultimate", ...ultimate.slice(1)]] : []),
      ...reportCorpusRows(tab, columns, runLinks, weekly),
      ...rows.filter(([engine]) => engine !== "ultimate"),
    ]));
  }

  sections.push(
    "## Search latency",
    "Corpus timings measure CLI search calls. Other provider timings come from NEEDLE.",
    markdownTable(
      ["Engine", "p50", "p95"],
      reportLatency(report, weekly).map(({ engine, p50Label, p95Label }) => [engine, p50Label ?? "—", p95Label ?? "—"]),
    ),
    "## Appendix",
    `[Search and scoring methodology](${site}/#appendix)`,
  );

  if (fullRuns.length) {
    sections.push("### Browse full runs", fullRuns.map((run) =>
      `- [${reportLabels[run.vertical]}](${site}/runs/${run.id}) · ${dateUtc.format(new Date(run.upstreamRunDate))} UTC · ${run.queryCount} questions`,
    ).join("\n"));
  }

  return `${sections.filter(Boolean).join("\n\n")}\n`;
}
