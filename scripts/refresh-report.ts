import { rename, writeFile } from "node:fs/promises";
import { reportTabs, type PublishedReport, type ReportTab } from "../src/lib/published-report";

const source = "https://keenableai.github.io/needle/";
const tableIds = {
  overall: "lb-overall",
  scholar: "lb-scholar",
  news: "lb-fresh",
  finance: "lb-company",
  agentic_rare: "lb-rare",
  legal: "lb-legal",
} satisfies Record<ReportTab, string>;

function percent(text: string): number {
  if (!/^[−-]?\d+(?:\.\d+)?%$/.test(text)) throw new Error(`Invalid NEEDLE percentage ${text}`);
  return Number(text.slice(0, -1).replace("−", "-")) / 100;
}

function ms(text: string): number {
  const match = /^(\d+(?:\.\d+)?) (ms|s)$/.exec(text);
  if (!match) throw new Error(`Invalid NEEDLE latency ${text}`);
  return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

const reply = await fetch(source, { signal: AbortSignal.timeout(30_000) });
if (!reply.ok) throw new Error(`NEEDLE report returned HTTP ${reply.status}`);
const html = await reply.text();
const tableNames = [...Object.values(tableIds), "standings", "latency-dumbbell"];
const tables = new Map<string, string[][]>();
const labels = new Map<string, string>();
const parser = new HTMLRewriter();

for (const id of tableNames) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  tables.set(id, rows);
  parser.on(`#${id} table tr`, {
    element(element) {
      row = [];
      element.onEndTag(() => { if (row.length) rows.push(row); });
    },
  });
  for (const selector of [`#${id} th`, `#${id} td`]) {
    parser.on(selector, {
      element(element) {
        cell = "";
        element.onEndTag(() => { row.push(cell.trim()); });
      },
      text(chunk) {
        cell += chunk.text.replaceAll("&nbsp;", " ");
      },
    });
  }
}

for (const id of ["updated", ...Object.values(tableIds).map((id) => `${id}-sub`)]) {
  parser.on(`#${id}`, { text(chunk) { labels.set(id, (labels.get(id) ?? "") + chunk.text); } });
}
await parser.transform(new Response(html)).text();

function table(id: string) {
  const [columns, ...rows] = tables.get(id) ?? [];
  if (!columns || !rows.length || rows.some((row) => row.length !== columns.length)) {
    throw new Error(`Missing or malformed NEEDLE table ${id}`);
  }
  return { columns, rows };
}

const standingsTable = table("standings");
const expectedAxes = "Scholar,News,Finance,AgenticRare,Legal";
if (standingsTable.columns.slice(3).join(",") !== expectedAxes) throw new Error("Unexpected NEEDLE standings axes");
const [ultimate, gapRow, ...engineRows] = standingsTable.rows;
if (ultimate[0] !== "ultimate (raw)" || gapRow[0] !== "gap to ultimate") throw new Error("Missing NEEDLE ceiling");

const logoBlock = html.match(/const ENGINE_LOGOS = new Map\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
const logos: Record<string, string> = Object.fromEntries(
  [...logoBlock.matchAll(/\["([\w-]+)", "(data:image\/(?:png;base64|svg\+xml),[^"]+)"\]/g)]
    .map(([, id, uri]) => [id, uri]),
);
if (logos.keenable) logos.keenable = logos.keenable.replaceAll("%232A2A2A", "%23E6E6E6");
const logoAliases = {
  Keenable: "keenable",
  "context.dev": "context",
  "google/serper": "google",
  "parallel-advanced": "parallel",
  "parallel-fast": "parallel",
  "parallel-turbo": "parallel",
  "perplexity-fast": "perplexity",
};
for (const [name, key] of Object.entries(logoAliases)) if (logos[key]) logos[name] = logos[key];

const sourceUpdated = labels.get("updated")?.trim().replace(/^Last run:\s*/, "").replace(/\.$/, "");
if (!sourceUpdated) throw new Error("Missing NEEDLE report date");

// Upstream labels omit the year. Anchor them when importing, including across New Year.
function reportDateIso(label: string, reference: Date): string {
  if (!/^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC$/.test(label)) {
    throw new Error(`Invalid NEEDLE report date ${label}`);
  }
  const date = new Date(label.replace(",", ` ${reference.getUTCFullYear()},`));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid NEEDLE report date ${label}`);
  if (date.getTime() > reference.getTime()) date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString();
}

const sourceUpdatedAt = reportDateIso(sourceUpdated, new Date());
const report: PublishedReport = {
  sourceUpdated,
  sourceUpdatedAt,
  standings: engineRows.map(([engine, overall, , ...shares]) => ({
    engine,
    overall: percent(overall),
    shares: shares.map((share) => share.endsWith("%") ? percent(share) : null),
  })),
  gap: { overall: percent(gapRow[1]), shares: gapRow.slice(3).map(percent) },
  leaderboards: Object.fromEntries(reportTabs.map((tab) => {
    const id = tableIds[tab];
    const caption = labels.get(`${id}-sub`)?.trim() ?? "";
    const latestLabel = caption.match(/\blatest (.+ UTC)$/)?.[1];
    return [tab, {
      ...table(id), caption,
      latestRunAt: latestLabel ? reportDateIso(latestLabel, new Date(sourceUpdatedAt)) : null,
    }];
  })) as PublishedReport["leaderboards"],
  latency: table("latency-dumbbell").rows.map(([engine, p50Label, p95Label]) => ({
    engine,
    p50: ms(p50Label),
    p95: ms(p95Label),
    p50Label,
    p95Label,
  })),
  logos,
};

const output = "data/needle-report.json";
await writeFile(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
await rename(`${output}.tmp`, output);
console.log(`Saved NEEDLE results through ${sourceUpdated} to ${output}`);
