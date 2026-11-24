import Image from "next/image";
import type { PublishedReport } from "@/lib/published-report";
import { corpusAgent, corpusNeedle } from "@/lib/report-results";
import { CorpusModeMark } from "./corpus-mode-mark";

export function EngineName({ engine, logos, showModeMark = true }: {
  engine: string;
  logos: PublishedReport["logos"];
  showModeMark?: boolean;
}) {
  if (engine === "ultimate") {
    return (
      <span className="report-engine">
        <svg className="report-engine-logo" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="var(--ui-muted-foreground)" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M3 17a9 9 0 0 1 18 0M12 17l4-5" />
        </svg>
        <em>Ultimate</em>
      </span>
    );
  }
  const mode = engine === corpusAgent ? "agent" : engine === corpusNeedle ? "needle" : null;
  const logo = mode ? "/icon.svg"
    : logos[engine] ?? (engine === "bing/searchapi" ? "/searchapi-icon.png" : null);
  return (
    <span className="report-engine">
      {mode && showModeMark && <CorpusModeMark mode={mode} />}
      {logo && <Image className="report-engine-logo" src={logo} alt="" width={16} height={16} unoptimized />}
      {engine}
    </span>
  );
}

export interface LeaderboardTableProps {
  columns: string[];
  rows: string[][];
  corpusRows: string[][];
  logos: PublishedReport["logos"];
}

export function LeaderboardTable({ columns, rows, corpusRows, logos }: LeaderboardTableProps) {
  const ultimateRow = rows.find(([engine]) => engine === "ultimate");

  function renderRow([engine, ...values]: string[], corpus = false) {
    return (
      <tr key={engine} className={corpus ? "row--corpus report-corpus-row" : engine === "ultimate" ? "row--ultimate" : undefined}>
        <th scope="row"><EngineName engine={engine} logos={logos} /></th>
        {values.map((value, index) => {
          const heading = columns[index + 1];
          return <td key={heading} className={heading === "95% CI" ? "num report-leaderboard-ci" : "num"}>{value || "—"}</td>;
        })}
      </tr>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="data-table results-table report-leaderboard-table">
        <thead>
          <tr>{columns.map((heading, index) => <th scope="col" className={index ? "num" : undefined} key={heading}>{heading}</th>)}</tr>
        </thead>
        <tbody>
          {ultimateRow && renderRow(ultimateRow)}
          {corpusRows.map((row) => renderRow(row, true))}
          {rows.filter(([engine]) => engine !== "ultimate").map((row) => renderRow(row))}
        </tbody>
      </table>
    </div>
  );
}
