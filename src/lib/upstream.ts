import { fieldTypeFor } from "./needle-scorer";
import type { BenchmarkInputQuery, NeedleCompatibleProviderSummary, QueryProvenance, VerticalId } from "./types";

const HF_API_BASE = "https://huggingface.co/api/datasets";
const HF_RAW_BASE = "https://huggingface.co/datasets";

export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  corpus: "Corpus",
  ultimate: "Ultimate (Oracle Ceiling)",
  "keenable-realtime": "Keenable",
  keenable: "Keenable (Standard)",
  exa: "Exa",
  "exa-lite": "Exa Lite",
  "exa-instant": "Exa Instant",
  brave: "Brave",
  "brave-llmcontext": "Brave LLM Context",
  parallel: "Parallel Advanced",
  "parallel-fast": "Parallel Fast",
  "parallel-turbo": "Parallel Turbo",
  perplexity: "Perplexity",
  "perplexity-fast": "Perplexity Fast",
  tavily: "Tavily",
  linkup: "Linkup",
  you: "You.com",
  firecrawl: "Firecrawl",
  tinyfish: "TinyFish",
  kagi: "Kagi",
  jina: "Jina",
  deepseek: "DeepSeek",
  seltz: "Seltz",
  webiq: "Web IQ",
  octen: "Octen",
  "claude-search": "Claude Search",
  "chatgpt-search": "ChatGPT Search",
  google: "Google",
  bing: "Bing",
  ceramic: "Ceramic",
  context: "Context",
};

export function providerDisplayName(engine: string): string {
  return PROVIDER_DISPLAY_NAMES[engine] ?? engine;
}

export interface UpstreamRunDescriptor {
  runId: string;
  runDateIso: string;
  vertical: VerticalId;
  files: string[];
  upstreamUrl: string;
}

export const suiteFiles = {
  finance: ["gold", "recall"],
  scholar: ["scholar", "scholar"],
  legal: ["legal", "legal"],
  news: ["fresh", "ndcg"],
  agentic_rare: ["agentic_rare", "agentic_rare"],
} as const;

export function relevanceSuite(vertical: VerticalId) {
  return vertical === "news" || vertical === "agentic_rare";
}

export function runIdToIso(runId: string): string {
  // e.g. 2026-11-22T0437Z -> 2026-11-22T04:37:00Z
  const m = runId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z$/);
  if (!m) return runId;
  return `${m[1]}T${m[2]}:${m[3]}:00Z`;
}

export async function describeRun(upstreamRepo: string, runId: string, { allowMissing = false } = {}): Promise<UpstreamRunDescriptor[]> {
  if (!/^\d{4}-\d{2}-\d{2}T\d{4}Z$/.test(runId)) throw new Error(`Invalid run ID: ${runId}`);
  const url = `${HF_API_BASE}/${upstreamRepo}/tree/main/runs/${runId}`;
  const entries = await fetchJson<Array<{ path: string }>>(url, allowMissing ? [] : undefined);
  return describeFiles(upstreamRepo, runId, entries.map((e) => e.path.split("/").pop()!));
}

function describeFiles(repo: string, runId: string, files: string[]): UpstreamRunDescriptor[] {
  return (Object.keys(suiteFiles) as VerticalId[])
    .filter((id) => files.includes(suiteFiles[id][0] + ".jsonl") && files.includes(suiteFiles[id][1] + ".json"))
    .map((vertical) => ({
      runId, vertical, files, runDateIso: runIdToIso(runId),
      upstreamUrl: `https://huggingface.co/datasets/${repo}/tree/main/runs/${runId}`,
    }));
}

export async function discoverUpstreamRuns(params: {
  upstreamRepo: string;
  startDate: string;
}): Promise<UpstreamRunDescriptor[]> {
  const rows = await fetchJson<Array<{ id: string; artifacts: string[] }>>("https://keenableai.github.io/needle/data/runs.json");
  return rows.filter((row) => Date.parse(runIdToIso(row.id)) >= Date.parse(params.startDate))
    .flatMap((row) => describeFiles(params.upstreamRepo, row.id, row.artifacts))
    .sort((a, b) => a.runId.localeCompare(b.runId));
}

type Origin = { bucket?: string; syntax?: string; provenance?: Record<string, unknown> };
interface Gold {
  field?: string;
  value?: string | number;
  field_type?: string;
  aliases?: string[];
  case_key?: string;
  paper_key?: string;
  case_name?: string;
  citation?: string;
  heading?: string;
  ids?: Record<string, unknown>;
  freshness_window?: string;
  tier?: string;
}
interface InputRow {
  query_id: string;
  query_text: string;
  query_origin?: string | Origin;
  gold?: string | Gold;
  hour_ts?: string;
}

export interface RawUpstreamPerQuery {
  query: string;
  field?: string;
  paper_key?: string;
  case_key?: string;
  bucket?: string;
  syntax?: string;
  hit_rank?: number | null;
  det_rank?: number | null;
  score?: number | null;
  ndcg?: number | null;
  dcg?: number | null;
  query_profile?: Record<string, unknown> | null;
  results: Array<{
    url: string; title: string; snippet: string;
    det_match?: boolean; matched?: boolean; judge_match?: boolean | null;
    rating?: number | null; reasoning?: string;
  }>;
  search_error: string | Record<string, unknown> | null;
  queried_at?: string | null;
}
export interface PublishedProviderMetrics {
  recall_at_k?: number | null;
  mrr_at_k?: number | null;
  mean_ndcg?: number | null;
  num_scored?: number;
  account_errors?: number;
  service_errors?: number;
  judge_upgrades?: number;
}

export function applyPublishedProviderMetrics(summary: NeedleCompatibleProviderSummary, published: PublishedProviderMetrics) {
  if (published.num_scored !== undefined) summary.scored = published.num_scored;
  if (published.mean_ndcg !== undefined) summary.meanNdcg = published.mean_ndcg;
  if (published.recall_at_k !== undefined) {
    summary.recallAtK = published.recall_at_k;
    summary.hits = summary.recallAtK === null ? null : Math.round(summary.recallAtK * summary.scored);
  }
  if (published.mrr_at_k !== undefined) summary.mrrAtK = published.mrr_at_k;
  summary.accountErrors = published.account_errors ?? summary.accountErrors;
  summary.serviceErrors = published.service_errors ?? summary.serviceErrors;
  summary.judgeUpgrades = published.judge_upgrades ?? summary.judgeUpgrades;
}

interface Report {
  num_queries: number;
  num_results: number;
  snippet_chars?: number;
  judge_model?: string;
  engines: Record<string, PublishedProviderMetrics & { per_query_path: string }>;
}

export interface ParsedBatch {
  vertical: VerticalId;
  runId: string;
  runDateIso: string;
  upstreamUrl: string;
  snippetChars: number;
  k: number;
  judgeModel?: string;
  engines: string[];
  publishedMetrics: Record<string, PublishedProviderMetrics>;
  queries: BenchmarkInputQuery[];
  sourceRows: Array<{ gold: Gold; query_text: string; query_origin: Origin; hour_ts?: string }>;
  perEngine: Record<string, RawUpstreamPerQuery[]>;
}

function parseOrigin(raw: InputRow["query_origin"]): {
  bucket?: string;
  syntax?: string;
  provenance: QueryProvenance;
} {
  let obj: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      obj = {};
    }
  } else if (raw && typeof raw === "object") {
    obj = raw;
  }
  const prov = (obj.provenance && typeof obj.provenance === "object"
    ? obj.provenance
    : {}) as Record<string, unknown>;
  return {
    bucket: typeof obj.bucket === "string" ? obj.bucket : undefined,
    syntax: typeof obj.syntax === "string" ? obj.syntax : undefined,
    provenance: {
      entity: String(prov.entity ?? prov.case_name ?? prov.title ?? "") || null,
      ticker: typeof prov.ticker === "string" ? prov.ticker : null,
      cik: typeof prov.cik === "string" || typeof prov.cik === "number" ? prov.cik : null,
      qid: typeof prov.qid === "string" ? prov.qid : null,
      registry: typeof prov.registry === "string" ? prov.registry : null,
      sourceUrl: String(prov.source_url ?? prov.url ?? "") || null,
    },
  };
}

async function fetchJson<T>(url: string, ifMissing?: T): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": "runcorpus-needle/0.1" } });
  if (res.status === 404 && ifMissing !== undefined) return ifMissing;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "runcorpus-needle/0.1" } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return await res.text();
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

export async function fetchBatch(params: { upstreamRepo: string; runId: string; vertical: VerticalId; slice: string | null }): Promise<ParsedBatch> {
  const { upstreamRepo, runId, vertical, slice } = params;
  const [inputName, reportName] = suiteFiles[vertical];
  const base = `${HF_RAW_BASE}/${upstreamRepo}/resolve/main/runs/${runId}`;
  const [input, report] = await Promise.all([
    fetchText(`${base}/${inputName}.jsonl`),
    fetchJson<Report>(`${base}/${reportName}.json`),
  ]);
  const rows = input.trim().split(/\r?\n/).map((line) => {
    const raw: InputRow = JSON.parse(line);
    const gold: Gold = typeof raw.gold === "string" ? JSON.parse(raw.gold) : raw.gold ?? {};
    const origin: Origin = typeof raw.query_origin === "string" ? JSON.parse(raw.query_origin) : raw.query_origin ?? {};
    return { ...raw, gold, query_origin: origin };
  });
  const engines = Object.keys(report.engines).sort();
  const perEngine = Object.fromEntries(await mapWithConcurrency(engines, 8, async (engine) => {
    const file = await fetchJson<{ per_query: RawUpstreamPerQuery[] }>(`${base}/${report.engines[engine].per_query_path}`);
    if (file.per_query.length !== report.num_queries) throw new Error(`Incomplete provider archive: ${engine}`);
    return [engine, file.per_query] as const;
  }));
  const reference = perEngine.ultimate ?? perEngine[engines[0]];
  if (!reference?.length) throw new Error(`No published questions in ${runId}/${reportName}`);
  const key = (text: string, item: string, bucket: string) => JSON.stringify([text, item, bucket]);
  const sourceGroups = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = key(row.query_text, String(row.gold.field ?? row.gold.paper_key ?? row.gold.case_key ?? ""), relevanceSuite(vertical) ? "" : row.query_origin.bucket ?? "");
    const group = sourceGroups.get(id) ?? [];
    group.push(row);
    sourceGroups.set(id, group);
  }
  const sourceRows: typeof rows = [];
  const indices: number[] = [];
  const queries: BenchmarkInputQuery[] = [];
  for (const [i, ref] of reference.entries()) {
    if (slice && ref.field !== slice) continue;
    const id = key(ref.query, ref.field ?? ref.paper_key ?? ref.case_key ?? "", relevanceSuite(vertical) ? "" : ref.bucket ?? "");
    const row = sourceGroups.get(id)?.shift();
    if (!row) throw new Error(`No matching published input for ${vertical} query ${i}: ${ref.query}`);
    for (const engine of engines) {
      const other = perEngine[engine][i];
      if (key(other.query, other.field ?? other.paper_key ?? other.case_key ?? "", relevanceSuite(vertical) ? "" : other.bucket ?? "") !== id) {
        throw new Error(`Misaligned ${engine} archive at ${runId}/${i}`);
      }
    }
    indices.push(i);
    sourceRows.push(row);
    const origin = parseOrigin(row.query_origin);
    const field = ref.field ?? (vertical === "scholar" ? "paper" : vertical === "legal" ? "legal item" : "relevance");
    const { gold } = row;
    const referenceAnswer = vertical === "finance" ? String(gold.value ?? "") :
      relevanceSuite(vertical) ? "" : [gold.case_name ?? gold.citation ?? origin.provenance.entity,
        gold.heading, gold.ids && JSON.stringify(gold.ids)].filter(Boolean).join(" · ");
    queries.push({
      index: queries.length, queryId: row.query_id, queryText: ref.query, field,
      fieldType: gold.field_type ?? fieldTypeFor(field), bucket: ref.bucket ?? origin.bucket ?? vertical,
      syntax: ref.syntax ?? origin.syntax ?? "plain", tier: gold.tier ?? "",
      freshnessWindow: gold.freshness_window ?? "", goldValue: referenceAnswer,
      goldAliases: gold.aliases ?? [], provenance: origin.provenance,
    });
  }
  for (const engine of engines) perEngine[engine] = indices.map((i) => perEngine[engine][i]);
  return {
    runId, vertical, engines, publishedMetrics: report.engines, queries, sourceRows, perEngine, k: report.num_results,
    snippetChars: report.snippet_chars ?? 2000, judgeModel: report.judge_model,
    runDateIso: runIdToIso(runId), upstreamUrl: `https://huggingface.co/datasets/${upstreamRepo}/tree/main/runs/${runId}`,
  };
}
