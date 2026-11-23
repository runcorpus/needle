"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { reportTabs, type PublishedReport, type ReportTab } from "@/lib/published-report";
import { benchmarkSuites as axisSuites, type CorpusWeeklyReport } from "@/lib/corpus-report";
import {
  corpusAgent, corpusNeedle, reportCorpusRows, reportLabels as labels, reportLatency,
  reportPercent as percent, reportStandings, type ReportRunLink,
} from "@/lib/report-results";
import { ReportCardActions } from "./report-card-actions";

const colors = ["#a1bfff", "#e082aa", "#ecd675", "#eaa47c", "#aca0f5", "#5dc5cd", "#dcad64", "#d5a6df", "#e68884", "#8fbbf7"];
const axisCount = axisSuites.length;
const corpusEngines = [corpusAgent, corpusNeedle];
const corpusColor = "#5ee69c";
const radarSize = { width: 444, height: 390 };
const radarCenter = { x: radarSize.width / 2, y: 214 };
const markerShapes = [
  "M-3.4 0a3.4 3.4 0 1 0 6.8 0a3.4 3.4 0 1 0-6.8 0Z",
  "M-3.3-3.3h6.6v6.6h-6.6Z",
  "M0-4.4 4.4 0 0 4.4-4.4 0Z",
  "M0-4 4 3.4h-8Z",
  "M0 4 4-3.4h-8Z",
];
// NEEDLE assigns shapes in registration order. Keep that order as scores move.
const markerOrder = [
  "Keenable", "google/serper", "bing/searchapi", "brave", "brave-llmcontext", "exa", "exa-lite",
  "parallel-advanced", "parallel-turbo", "perplexity-fast", "perplexity", "tavily", "linkup", "you",
  "firecrawl", "tinyfish", "kagi", "jina", "context.dev", "deepseek", "octen", "claude-search",
  "chatgpt-search", "parallel-fast", "seltz", "webiq",
];
type RadarPoint = [number, number];

function EngineName({ engine, logos }: { engine: string; logos: PublishedReport["logos"] }) {
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
  const logo = corpusEngines.includes(engine) ? "/icon.svg"
    : logos[engine] ?? (engine === "bing/searchapi" ? "/searchapi-icon.png" : null);
  return (
    <span className="report-engine">
      {logo && <Image className="report-engine-logo" src={logo} alt="" width={16} height={16} unoptimized />}
      {engine}
    </span>
  );
}

function radarPoint(axis: number, value: number, radius: number): RadarPoint {
  const angle = (axis / axisCount) * 2 * Math.PI - Math.PI / 2;
  return [
    Number((radarCenter.x + radius * value * Math.cos(angle)).toFixed(3)),
    Number((radarCenter.y + radius * value * Math.sin(angle)).toFixed(3)),
  ];
}

function radarRing(values: number[], radius: number) {
  return values.map((value, axis) => radarPoint(axis, value, radius).join(",")).join(" ");
}

function distanceToSegment([x, y]: RadarPoint, [ax, ay]: RadarPoint, [bx, by]: RadarPoint) {
  const dx = bx - ax;
  const dy = by - ay;
  const projection = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1);
  const t = Math.max(0, Math.min(1, projection));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function midpoint([ax, ay]: RadarPoint, [bx, by]: RadarPoint): RadarPoint {
  return [(ax + bx) / 2, (ay + by) / 2];
}

function RadarStandings({ report, runs, weekly }: { report: PublishedReport; runs: ReportRunLink[]; weekly: CorpusWeeklyReport | null }) {
  const chartId = useId();
  const hatchId = `${chartId}-gap-hatch`;
  const gapMaskId = `${chartId}-gap-mask`;
  const arrowId = `${chartId}-gap-arrow`;
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [selected, setSelected] = useState(() => new Set([...corpusEngines, ...report.standings.slice(0, 3).map(({ engine }) => engine)]));
  const highlighted = hovered ?? focused;
  const { measured, rows } = reportStandings(report, runs, weekly);
  const extent = Math.max(1, ...rows.flatMap(({ shares }) => shares.map((share) => share ?? 0)));
  const radius = 176 / extent;
  const pointAt = (axis: number, value: number) => radarPoint(axis, value, radius);
  const simulationCount = runs.filter((run) => run.simulated).length;
  const intervals = new Map(report.leaderboards.overall.rows.map(([engine, , interval]) => [engine, interval]));
  for (const [engine, score] of [[corpusNeedle, weekly?.overall], [corpusAgent, weekly?.agent?.overall]] as const) {
    if (score?.interval) intervals.set(engine, `[${score.interval.map((value) => `${(value * 100).toFixed(1)}%`).join(", ")}]`);
  }
  const series = rows.map((row, index) => {
    const slot = markerOrder.indexOf(row.engine);
    const isCorpus = corpusEngines.includes(row.engine);
    const color = isCorpus ? corpusColor : colors[(index - corpusEngines.length) % colors.length];
    const marker = isCorpus
      ? markerShapes[row.engine === corpusAgent ? 1 : 0]
      : markerShapes[(slot < 0 ? index - corpusEngines.length : slot) % markerShapes.length];
    const points = row.shares.map((value, axis) => value == null ? null : pointAt(axis, value));
    const segments = points.flatMap((point, axis) => {
      const next = points[(axis + 1) % axisCount];
      return point && next ? [[point, next] as const] : [];
    });
    return { ...row, color, marker, points, segments };
  });
  const order = (engine: string) => engine === highlighted ? 2 : Number(selected.has(engine));
  const traces = [...series].sort((a, b) => order(a.engine) - order(b.engine));
  const activeSeries = series.find(({ engine }) => engine === highlighted);
  const ultimate = radarRing(axisSuites.map(() => 1), radius);
  const gaps = report.gap.shares;
  const widestGap = gaps.reduce((widest, gap, axis) => gap < gaps[widest] ? axis : widest, 0);
  const previousAxis = (widestGap + axisCount - 1) % axisCount;
  const nextAxis = (widestGap + 1) % axisCount;
  const neighbor = gaps[previousAxis] < gaps[nextAxis] ? previousAxis : nextAxis;
  const edge = midpoint(pointAt(widestGap, 1), pointAt(neighbor, 1));
  const covered = midpoint(pointAt(widestGap, 1 + gaps[widestGap]), pointAt(neighbor, 1 + gaps[neighbor]));
  const [arrowX, arrowY] = midpoint(edge, covered);
  const edgeX = edge[0] - radarCenter.x;
  const edgeY = edge[1] - radarCenter.y;
  const edgeDistance = Math.hypot(edgeX, edgeY);
  const calloutX = Math.max(26, Math.min(radarSize.width - 26, edge[0] + edgeX / edgeDistance * 52));
  const calloutY = Math.max(25, Math.min(radarSize.height - 30, edge[1] + edgeY / edgeDistance * 52));
  const arrowDistance = Math.hypot(arrowX - calloutX, arrowY - calloutY) || 1;
  const arrowStart = Math.min(28, arrowDistance * 0.65);

  function highlightPlot(event: PointerEvent<SVGSVGElement>) {
    if (event.pointerType === "touch") return;
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    let nearest: string | null = null;
    let distance = 13;
    for (const row of series) {
      const distances = row.segments.map(([start, end]) => distanceToSegment([point.x, point.y], start, end));
      const closest = Math.min(...distances, ...row.points.flatMap((vertex) => vertex ? [Math.hypot(point.x - vertex[0], point.y - vertex[1])] : []));
      if (closest < distance) {
        nearest = row.engine;
        distance = closest;
      }
    }
    setHovered(nearest);
  }

  function toggle(engine: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(engine)) next.delete(engine);
      else next.add(engine);
      return next;
    });
  }

  return (
    <div id="standings" className="panel-box report-chart-card">
      <ReportCardActions cardId="standings" label="standings" />
      <div className="report-chart-heading">
        <h3>Standings — all verticals</h3>
        <p>
          Each axis plots an engine’s score as a share of <em>Ultimate</em>, the pooled ceiling across providers—farther
          out is better, and the hatched band marks how much remains between the best single engine and that ceiling.
          Hover to highlight a series or click a row to pin it.
        </p>
        <p>
          {measured
            ? "Corpus standings reflect measured runs from the past seven days"
            : `Corpus reflects the latest full batch for each suite${simulationCount ? ` (${simulationCount} simulated)` : ""}`}
          ; web search standings are seven-day averages.
        </p>
      </div>
      <div className="report-standings-grid">
        <div className="report-standings-list">
          <div className="report-standings-columns"><span>Engine</span><span>Of Ultimate</span></div>
          {series.map(({ engine, color, overall, marker }) => {
            const score = overall == null ? "—" : percent(overall);
            const interval = intervals.get(engine);
            return (
              <button
                key={engine}
                type="button"
                className={`report-standing-row${corpusEngines.includes(engine) ? " report-corpus-row" : ""}`}
                aria-pressed={selected.has(engine)}
                data-highlighted={highlighted === engine}
                data-dimmed={highlighted != null && highlighted !== engine}
                title={`${engine} · ${score} of Ultimate${interval ? ` · 95% CI ${interval}` : ""}`}
                onPointerEnter={(event) => { if (event.pointerType !== "touch") setHovered(engine); }}
                onPointerLeave={() => setHovered(null)}
                onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setFocused(engine); }}
                onBlur={() => setFocused(null)}
                onClick={() => toggle(engine)}
              >
                <svg className="report-series-marker" viewBox="-5 -5 10 10" aria-hidden="true">
                  <path d={marker} fill={color} />
                </svg>
                <EngineName engine={engine} logos={report.logos} />
                <strong>{score}</strong>
              </button>
            );
          })}
        </div>
        <figure className="report-radar">
          <svg viewBox={`0 0 ${radarSize.width} ${radarSize.height}`} role="img" aria-label="Engine performance across five suites as a share of Ultimate" onPointerMove={highlightPlot} onPointerLeave={() => setHovered(null)}>
            <defs>
              <pattern id={hatchId} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(42)">
                <path d="M 0 0 V 7" stroke="var(--report-gap)" opacity=".28" />
              </pattern>
              <mask id={gapMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width={radarSize.width} height={radarSize.height}>
                <polygon points={ultimate} fill="white" />
                {series.filter(({ engine }) => !corpusEngines.includes(engine)).map(({ engine, points }) => {
                  const plotted = points.flatMap((point) => point ? [point.join(",")] : []);
                  return plotted.length >= 3 ? <polygon key={engine} points={plotted.join(" ")} fill="black" /> : null;
                })}
              </mask>
              <marker id={arrowId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M0 0 8 4 0 8Z" fill="var(--report-gap)" />
              </marker>
            </defs>
            <polygon points={ultimate} fill={`url(#${hatchId})`} mask={`url(#${gapMaskId})`} />
            {[0.25, 0.5, 0.75, 1].map((step) => (
              <polygon key={step} points={radarRing(axisSuites.map(() => step), radius)} fill="none" stroke="var(--ui-border)" />
            ))}
            {axisSuites.map((suite, axis) => {
              const [x, y] = pointAt(axis, extent);
              const [labelX, labelY] = pointAt(axis, extent * 1.13);
              const [gapX, gapY] = pointAt(axis, 1 + report.gap.shares[axis] / 2);
              const side = axis === 0 ? "middle" : axis < 3 ? "start" : "end";
              return (
                <g key={suite}>
                  <line x1={radarCenter.x} y1={radarCenter.y} x2={x} y2={y} stroke="var(--ui-border)" />
                  <text className="report-radar-axis" x={labelX} y={labelY} textAnchor={side} dominantBaseline="central">{labels[suite]}</text>
                  <text className="report-radar-gap" x={gapX + (axis === 0 || axis === 3 ? -7 : 6)} y={gapY - 9} textAnchor={axis === 0 ? "end" : axis === 4 ? "start" : side}>{percent(report.gap.shares[axis])}</text>
                </g>
              );
            })}
            {traces.map(({ engine, shares, color, marker, points, segments }) => {
              const active = highlighted ? highlighted === engine : selected.has(engine);
              const path = segments.map(([point, next]) => `M ${point.join(" ")} L ${next.join(" ")}`).join(" ");
              return (
                <g key={engine} opacity={active ? 1 : 0.16}>
                  <path d={path} fill="none" stroke={color} strokeWidth={active ? 2 : 1} />
                  {points.map((point, axis) => point && (
                    <path key={axis} d={marker} transform={`translate(${point.join(" ")})`} fill={color} stroke="var(--panel)" strokeWidth="1">
                      <title>{`${engine} · ${labels[axisSuites[axis]]} · ${percent(shares[axis]!)}`}</title>
                    </path>
                  ))}
                </g>
              );
            })}
            <g className="report-radar-gap" aria-label={`The gap to Ultimate is ${percent(report.gap.overall)}`}>
              <line
                x1={calloutX + (arrowX - calloutX) / arrowDistance * arrowStart}
                y1={calloutY + (arrowY - calloutY) / arrowDistance * arrowStart}
                x2={arrowX}
                y2={arrowY}
                stroke="var(--report-gap)"
                markerEnd={`url(#${arrowId})`}
              />
              <text x={calloutX} y={calloutY} textAnchor="middle">The gap</text>
              <text x={calloutX} y={calloutY + 13} textAnchor="middle">{percent(report.gap.overall)}</text>
            </g>
          </svg>
          {activeSeries && (
            <figcaption className="report-radar-highlight">
              <strong>{activeSeries.engine}</strong>
              {activeSeries.overall != null && <span>{percent(activeSeries.overall)} of Ultimate</span>}
            </figcaption>
          )}
        </figure>
      </div>
    </div>
  );
}

function Leaderboards({ report, runs, weekly }: { report: PublishedReport; runs: ReportRunLink[]; weekly: CorpusWeeklyReport | null }) {
  const [tab, setTab] = useState<ReportTab>("overall");
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    function selectLinkedTab() {
      const linkedTab = reportTabs.find((item) => window.location.hash === `#leaderboards-${item}`);
      if (!linkedTab) return;
      setTab(linkedTab);
      document.getElementById("leaderboards")?.scrollIntoView();
    }
    selectLinkedTab();
    window.addEventListener("hashchange", selectLinkedTab);
    return () => window.removeEventListener("hashchange", selectLinkedTab);
  }, []);

  const { caption, columns, rows } = report.leaderboards[tab];
  const ultimateRow = rows.find(([engine]) => engine === "ultimate");
  const run = runs.find(({ suite }) => suite === tab);
  const weeklySuite = tab === "overall" ? null : weekly?.suites[tab];
  const corpusRows = reportCorpusRows(tab, columns, runs, weekly);

  function renderMetricCell(heading: string, value: string) {
    return <td className={heading === "95% CI" ? "num report-leaderboard-ci" : "num"} key={heading}>{value || "—"}</td>;
  }

  function renderPublishedRow([engine, ...values]: string[]) {
    return (
      <tr key={engine} className={engine === "ultimate" ? "row--ultimate" : undefined}>
        <th scope="row"><EngineName engine={engine} logos={report.logos} /></th>
        {values.map((value, index) => renderMetricCell(columns[index + 1], value))}
      </tr>
    );
  }

  return (
    <div id="leaderboards" className="panel-box report-chart-card">
      <ReportCardActions cardId="leaderboards" anchor={`leaderboards-${tab}`} label={`${labels[tab]} leaderboard`} />
      <div className="report-chart-heading">
        <h3>7-day leaderboards</h3>
        <p>
          Corpus reports seven-day averages across measured batches (falling back to the latest saved run), alongside
          seven-day query-weighted averages and 95% confidence intervals from NEEDLE.
        </p>
      </div>
      <div className="report-tabs" role="tablist" aria-label="Leaderboard suite">
        {reportTabs.map((item, index) => (
          <button
            ref={(element) => { buttons.current[index] = element; }}
            id={`leaderboard-tab-${item}`}
            key={item}
            type="button"
            role="tab"
            aria-controls="leaderboard-panel"
            aria-selected={item === tab}
            tabIndex={item === tab ? 0 : -1}
            onClick={() => setTab(item)}
            onKeyDown={(event) => {
              const shortcuts: Record<string, number> = {
                ArrowLeft: (index + reportTabs.length - 1) % reportTabs.length,
                ArrowRight: (index + 1) % reportTabs.length,
                Home: 0,
                End: reportTabs.length - 1,
              };
              const next = shortcuts[event.key];
              if (next === undefined) return;
              event.preventDefault();
              setTab(reportTabs[next]);
              buttons.current[next]?.focus();
            }}
          >{labels[item]}</button>
        ))}
      </div>
      <div id="leaderboard-panel" role="tabpanel" aria-labelledby={`leaderboard-tab-${tab}`}>
        <p className="report-leaderboard-context">
          <span>{caption}</span>
          {tab !== "overall" && (
            <Link href={weeklySuite ? `/runs/${weeklySuite.latestRunId}` : run?.href ?? `/suites/${tab}`} prefetch={false}>{labels[tab]} Run</Link>
          )}
        </p>
        <div className="overflow-x-auto">
          <table className="data-table results-table report-leaderboard-table">
            <thead><tr>{columns.map((heading, index) => <th scope="col" className={index ? "num" : undefined} key={heading}>{heading}</th>)}</tr></thead>
            <tbody>
              {ultimateRow && renderPublishedRow(ultimateRow)}
              {corpusRows.map(([engine, ...values]) => (
                <tr key={engine} className="row--corpus report-corpus-row">
                  <th scope="row">
                    <EngineName engine={engine} logos={report.logos} />
                  </th>
                  {values.map((value, index) => renderMetricCell(columns[index + 1], value))}
                </tr>
              ))}
              {rows.filter(([engine]) => engine !== "ultimate").map(renderPublishedRow)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SearchLatency({ report, weekly }: { report: PublishedReport; weekly: CorpusWeeklyReport | null }) {
  const seriesColors = new Map(report.standings.map(({ engine }, index) => [engine, colors[index % colors.length]]));
  const rows = reportLatency(report, weekly);
  const low = Math.min(...rows.flatMap(({ p50 }) => p50 == null ? [] : [p50])) * 0.88;
  const high = Math.max(...rows.flatMap(({ p95 }) => p95 == null ? [] : [p95])) * 1.12;
  const position = (ms: number) => (Math.log(ms / low) / Math.log(high / low)) * 100;
  const ticks: number[] = [];
  for (let ms = 125 * 2 ** Math.ceil(Math.log2(low / 125)); ms <= high; ms *= 2) ticks.push(ms);

  return (
    <section id="latency" className="report-section">
      <h2 className="report-section-heading">Search latency</h2>
      <div id="latency-chart" className="panel-box report-chart-card">
        <ReportCardActions cardId="latency-chart" label="latency chart" />
        <div className="report-chart-heading">
          <h3>Search latency — last 7 days</h3>
          <p>
            Median (p50) to tail (p95) search-call times on a log scale—Corpus timings measure CLI search calls, while
            provider rows come from NEEDLE.
          </p>
        </div>
        <div className="report-latency-scroll">
          <figure className="report-latency-chart" aria-label="p50 and p95 search latency by engine">
            <div className="report-latency-axis" aria-hidden="true">
              {ticks.map((ms) => <span key={ms} style={{ "--latency-x": `${position(ms).toFixed(3)}%` } as CSSProperties}>{ms < 1000 ? `${ms} ms` : `${ms / 1000} s`}</span>)}
            </div>
            {rows.map(({ engine, p50, p95, p50Label, p95Label }, index) => {
              const isCorpus = corpusEngines.includes(engine);
              const rowClass = isCorpus ? "report-latency-row report-corpus-row" : "report-latency-row";
              if (p50 == null || p95 == null) return (
                <div className={rowClass} key={engine}><EngineName engine={engine} logos={report.logos} /></div>
              );
              const color = isCorpus ? corpusColor : seriesColors.get(engine) ?? colors[index % colors.length];
              const start = position(p50);
              const end = position(p95);
              const tooltipId = `latency-values-${index}`;
              const trackStyle = {
                "--latency-start": `${start.toFixed(3)}%`,
                "--latency-end": `${end.toFixed(3)}%`,
                "--latency-width": `${(end - start).toFixed(3)}%`,
                "--latency-color": color,
              } as CSSProperties;
              return (
                <div className={rowClass} key={engine} tabIndex={0} aria-describedby={tooltipId}>
                  <EngineName engine={engine} logos={report.logos} />
                  <div className="report-latency-track" aria-hidden="true" style={trackStyle}>
                    {ticks.map((ms) => <span className="report-latency-tick" key={ms} style={{ "--latency-x": `${position(ms).toFixed(3)}%` } as CSSProperties} />)}
                    <span className="report-latency-line" />
                    <span className="report-latency-point" />
                    <span className="report-latency-point report-latency-tail" />
                  </div>
                  <span id={tooltipId} className="report-latency-tooltip" role="tooltip">
                    <span>p50 <strong>{p50Label}</strong></span>
                    <span>p95 <strong>{p95Label}</strong></span>
                  </span>
                </div>
              );
            })}
            <figcaption className="report-latency-legend">
              <span>p50</span>
              <span>p95</span>
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}

export function HomeBenchmarkReport({ report, runs, weekly }: { report: PublishedReport; runs: ReportRunLink[]; weekly: CorpusWeeklyReport | null }) {
  return (
    <>
      <section id="leaderboard" className="report-section">
        <h2 className="report-section-heading">Quality results</h2>
        <p className="report-source-date">NEEDLE provider data through {report.sourceUpdated}</p>
        <RadarStandings report={report} runs={runs} weekly={weekly} />
        <Leaderboards report={report} runs={runs} weekly={weekly} />
      </section>
      <SearchLatency report={report} weekly={weekly} />
    </>
  );
}
