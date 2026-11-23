import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { benchmarkSuites } from "@/lib/corpus-report";
import { reportLabels } from "@/lib/report-results";

export const alt = "Corpus NEEDLE Benchmark. Corpus compared with live web search APIs across five suites.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const green = "#5ee69c";
const axes = [[0, -178], [169, -55], [105, 144], [-105, 144], [-169, -55]];
const outline = axes.map(([x, y]) => `${x},${y}`).join(" ");
const radii = [0.20, 0.17, 0.19, 0.15, 0.10];
const tracePoints = axes.map(([x, y], index) => [x * radii[index], y * radii[index]]);
const [square, circle] = tracePoints;
const trace = tracePoints.map(([x, y]) => `${x},${y}`).join(" ");

export default async function OpenGraphImage() {
  const fonts = join(process.cwd(), "node_modules", "geist", "dist", "fonts");
  const [regular, semibold, mono] = await Promise.all([
    readFile(join(fonts, "geist-sans", "Geist-Regular.ttf")),
    readFile(join(fonts, "geist-sans", "Geist-SemiBold.ttf")),
    readFile(join(fonts, "geist-mono", "GeistMono-Regular.ttf")),
  ]);

  return new ImageResponse(
    (
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", background: "#111111", color: "#fafafa", padding: "60px 68px 48px", fontFamily: "Geist" }}>
        <svg width="370" height="370" viewBox="-185 -190 370 370" style={{ position: "absolute", top: 98, right: 46 }}>
          {[0.25, 0.5, 0.75, 1].map((scale) => (
            <polygon key={scale} points={outline} transform={`scale(${scale})`} fill="none" stroke="#395346" strokeWidth={1.5 / scale} />
          ))}
          {axes.map(([x, y]) => <line key={x} x1="0" y1="0" x2={x} y2={y} stroke="#395346" />)}
          <polygon points={trace} fill={green} fillOpacity={0.1} stroke={green} strokeWidth="2" strokeLinejoin="round" />
          <rect x={square[0] - 7} y={square[1] - 7} width="14" height="14" rx="1" fill={green} />
          <circle cx={circle[0]} cy={circle[1]} r="7" fill={green} />
        </svg>

        <div style={{ display: "flex", width: 55, height: 55, position: "relative", borderRadius: 12, background: "#000000", border: "2px solid #343b35" }}>
          <div style={{ position: "absolute", left: 26, top: 12, width: 13, height: 27, background: "#41c977" }} />
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", gap: 22, fontSize: 88, fontWeight: 600, letterSpacing: "-4px", lineHeight: 1 }}>
            <span>Corpus</span>
            <span style={{ color: green }}>NEEDLE</span>
          </div>
          <div style={{ fontSize: 88, fontWeight: 600, letterSpacing: "-4px", lineHeight: 1 }}>Benchmark</div>
          <div style={{ marginTop: 27, color: "#b8b8b8", fontSize: 31 }}>Corpus vs. live web search APIs</div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", paddingTop: 26, borderTop: "1px solid #343b35", color: "#b8b8b8", fontFamily: "Geist Mono", fontSize: 24 }}>
          {benchmarkSuites.map((suite) => <span key={suite}>{reportLabels[suite]}</span>)}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: regular, weight: 400 },
        { name: "Geist", data: semibold, weight: 600 },
        { name: "Geist Mono", data: mono, weight: 400 },
      ],
    },
  );
}
