import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { benchmarkSuites } from "@/lib/corpus-report";
import type { PublishedReport } from "@/lib/published-report";
import { corpusAgent, corpusNeedle, reportLabels, reportPercent, reportStandings } from "@/lib/report-results";
import { loadCorpusWeeklyReport } from "@/lib/runs";
import publishedReport from "../data/needle-report.json";

export const alt = "Corpus NEEDLE benchmark standings. Corpus (Agent) and Corpus (NEEDLE) are highlighted across five search suites.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const background = "#111111";
const green = "#5ee69c";
const needleGreen = "#a6f0d4";
const muted = "#b8b8b8";
const border = "#303532";
const grid = "#3b4440";
const provider = "#99a8a0";
const center = { x: 210, y: 220 };
const plotRadius = 151;
const scoreColumnWidth = 232;

function radarPoint(axis: number, fraction: number) {
  const angle = axis * 2 * Math.PI / benchmarkSuites.length - Math.PI / 2;
  return [
    Math.round(center.x + plotRadius * fraction * Math.cos(angle)),
    Math.round(center.y + plotRadius * fraction * Math.sin(angle)),
  ] as const;
}

function StandingSymbol({ square }: { square: boolean }) {
  return <span style={{ width: 12, height: 12, borderRadius: square ? 1 : 6, background: square ? green : needleGreen }} />;
}

export default async function OpenGraphImage() {
  const fonts = join(process.cwd(), "node_modules", "geist", "dist", "fonts", "geist-sans");
  const [weekly, regular, semibold] = await Promise.all([
    loadCorpusWeeklyReport(),
    readFile(join(fonts, "Geist-Regular.ttf")),
    readFile(join(fonts, "Geist-SemiBold.ttf")),
  ]);
  const { rows } = reportStandings(publishedReport as PublishedReport, [], weekly);
  const corpus = rows.filter(({ engine }) => engine === corpusAgent || engine === corpusNeedle);
  const providers = rows.filter(({ engine }) => engine !== corpusAgent && engine !== corpusNeedle);
  const extent = Math.max(1, ...rows.flatMap(({ shares }) => shares.map((share) => share ?? 0)));

  const series = [...providers, ...corpus].map(({ engine, shares }) => {
    const square = engine === corpusAgent;
    const selected = square || engine === corpusNeedle;
    const points = shares.map((share, axis) => share == null ? null : radarPoint(axis, share / extent));
    const path = points.flatMap((point, axis) => {
      const next = points[(axis + 1) % benchmarkSuites.length];
      return point && next ? [`M ${point.join(" ")} L ${next.join(" ")}`] : [];
    }).join(" ");
    return { engine, square, selected, points, path, color: square ? green : needleGreen };
  });

  const scores = [
    ...benchmarkSuites.map((suite, axis) => ({ label: reportLabels[suite], values: corpus.map(({ shares }) => reportPercent(shares[axis])) })),
    { label: reportLabels.overall, values: corpus.map(({ overall }) => reportPercent(overall)) },
  ];

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background, color: "#fafafa", fontFamily: "Geist" }}>
        <div style={{ display: "flex", flexDirection: "column", position: "absolute", top: 38, left: 48, width: 650 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ display: "flex", width: 44, height: 44, position: "relative", borderRadius: 10, background: "#000", border: "2px solid #343b35" }}>
              <div style={{ position: "absolute", left: 20, top: 9, width: 10, height: 22, background: "#41c977" }} />
            </div>
            <div style={{ display: "flex", gap: 11, fontSize: 50, fontWeight: 600, letterSpacing: "-2px", lineHeight: 1 }}>
              <span>Corpus</span>
              <span style={{ color: green }}>NEEDLE</span>
            </div>
          </div>
          <div style={{ marginTop: 8, color: muted, fontSize: 27 }}>7-day benchmark standings</div>

          <div style={{ display: "flex", alignItems: "center", marginTop: 22, height: 44, fontSize: 25, fontWeight: 600, color: muted }}>
            <span style={{ flex: 1 }}>Suite</span>
            {corpus.map(({ engine }) => (
              <span key={engine} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: scoreColumnWidth, color: engine === corpusAgent ? green : needleGreen }}>
                <StandingSymbol square={engine === corpusAgent} />
                {engine}
              </span>
            ))}
          </div>
          {scores.map(({ label, values }) => {
            const overall = label === reportLabels.overall;
            return (
              <div key={label} style={{ display: "flex", alignItems: "center", height: overall ? 68 : 51, borderTop: `1px solid ${overall ? "#56655d" : border}`, fontSize: overall ? 36 : 29, fontWeight: overall ? 600 : 400 }}>
                <span style={{ flex: 1 }}>{label}</span>
                {values.map((value, index) => (
                  <span key={corpus[index].engine} style={{ display: "flex", justifyContent: "center", width: scoreColumnWidth, fontSize: overall ? 46 : 29, color: value === "—" ? muted : "#fafafa" }}>
                    {value}
                  </span>
                ))}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", position: "absolute", left: 745, top: 82, width: 420, height: 390 }}>
          <svg width="420" height="390" viewBox="0 0 420 390">
            {[0.25, 0.5, 0.75, 1].map((step) => (
              <polygon key={step} points={benchmarkSuites.map((_, axis) => radarPoint(axis, step / extent).join(",")).join(" ")} fill="none" stroke={step === 1 ? "#687870" : grid} strokeWidth={step === 1 ? 2 : 1} />
            ))}
            {benchmarkSuites.map((suite, axis) => {
              const [x, y] = radarPoint(axis, 1);
              return <line key={suite} x1={center.x} y1={center.y} x2={x} y2={y} stroke={grid} />;
            })}
            {series.map(({ engine, square, selected, points, path, color }) => (
              <g key={engine}>
                <path d={path} fill="none" stroke={selected ? color : provider} strokeOpacity={selected ? 1 : 0.24} strokeWidth={selected ? 2.5 : 1.3} strokeLinejoin="round" />
                {selected ? points.map((point, axis) => {
                  if (point == null) return null;
                  const [x, y] = point;
                  return square
                    ? <rect key={axis} x={x - 5.5} y={y - 5.5} width={11} height={11} rx={1} fill={color} stroke={background} />
                    : <circle key={axis} cx={x} cy={y} r={4.5} fill={color} stroke={background} />;
                }) : null}
              </g>
            ))}
          </svg>
          {benchmarkSuites.map((suite, axis) => {
            const [x, y] = radarPoint(axis, 1);
            const top = axis === 0;
            const right = axis === 1 || axis === 2;
            return (
              <span key={suite} style={{
                display: "flex",
                justifyContent: top ? "center" : right ? "flex-start" : "flex-end",
                position: "absolute",
                width: 130,
                left: top ? x - 65 : right ? x + 10 : x - 140,
                top: top ? y - 36 : y - 12,
                color: muted,
                fontSize: 19,
              }}>
                {reportLabels[suite]}
              </span>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", position: "absolute", left: 48, right: 48, bottom: 36, paddingTop: 20, borderTop: `1px solid ${border}`, color: muted, fontSize: 20 }}>
          <span>Scores as a share of Ultimate</span>
          <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 22, height: 2, background: "#687870" }} />
              100% of Ultimate
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 22, height: 2, background: "#4d5550" }} />
              Web search APIs
            </span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: regular, weight: 400 },
        { name: "Geist", data: semibold, weight: 600 },
      ],
    },
  );
}
