/**
 * Deterministic Finance answer matcher faithfully ported from keenableai/needle
 * (`src/needle/finance/canon.py` and `src/needle/finance/score.py`).
 *
 * Returns both the boolean match and a human-readable explanation of where
 * and why the evidence matched or missed.
 */

export const DEFAULT_SNIPPET_CHARS = 2000;

const LEGAL_SUFFIXES = new Set([
  "incorporated", "inc", "corporation", "corp", "company", "co", "limited",
  "ltd", "llc", "plc", "gmbh", "ag", "sa", "nv", "se", "spa", "kk", "pte",
  "pty", "bv", "oyj", "ab", "as", "lp", "holding", "holdings", "group", "the",
]);

const RAW_COUNTRY_ALIASES: Record<string, string> = {
  us: "united states",
  usa: "united states",
  "u.s.": "united states",
  "u.s.a.": "united states",
  "united states of america": "united states",
  america: "united states",
  uk: "united kingdom",
  "u.k.": "united kingdom",
  "great britain": "united kingdom",
  britain: "united kingdom",
  uae: "united arab emirates",
  prc: "china",
  "people's republic of china": "china",
  "republic of korea": "south korea",
  korea: "south korea",
  "russian federation": "russia",
  deutschland: "germany",
  nederland: "netherlands",
  holland: "netherlands",
};

const FIELD_CUES: Record<string, readonly string[]> = {
  ceo: ["ceo", "chief executive"],
  ceo_since: ["ceo", "chief executive", "appointed", "named", "since", "became", "took over", "named chief", "assumed"],
  ceo_company: ["ceo", "chief executive"],
  founded_year: ["founded", "founding", "established", "incorporated", "began", "started", "since"],
  employees: ["employee", "employees", "employs", "headcount", "workforce", "staff"],
  ticker: ["ticker", "symbol", "stock", "nasdaq", "nyse", "shares"],
  eps_diluted: ["eps", "per share", "earnings per"],
};

const FIELD_TYPES: Record<string, string> = {
  ceo: "person",
  ceo_since: "year",
  ceo_company: "entity",
  founded_year: "year",
  hq_country: "country",
  website: "domain",
  employees: "numeric_band",
  lei: "exact_id",
  ticker: "exact_id",
  filing: "exact_id",
  revenue: "money",
  net_income: "money",
  operating_income: "money",
  eps_diluted: "money",
};

const AMOUNT_SCALES: Record<string, number> = {
  trillion: 1e12,
  tn: 1e12,
  t: 1e12,
  billion: 1e9,
  bn: 1e9,
  b: 1e9,
  million: 1e6,
  mn: 1e6,
  mm: 1e6,
  m: 1e6,
  thousand: 1e3,
  k: 1e3,
};

const MONEY_REL_TOL = 0.001;
const HEADCOUNT_REL_TOL = 0.15;

export function fieldTypeFor(field: string): string {
  return FIELD_TYPES[field] ?? "exact_id";
}

export function cuesFor(field: string): readonly string[] {
  return FIELD_CUES[field] ?? [];
}

export function capSnippet(snippet: string, maxChars = DEFAULT_SNIPPET_CHARS): string {
  if (!snippet) return "";
  return snippet.length > maxChars ? snippet.slice(0, maxChars) : snippet;
}

export function titledSnippet(title: string, snippet: string, maxChars = DEFAULT_SNIPPET_CHARS): string {
  const capped = capSnippet(snippet, maxChars);
  return title ? `${title}\n${capped}` : capped;
}

export function squadNorm(value: unknown): string {
  const s = String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, " ")
    .replace(/\b(a|an|the)\b/g, " ");
  return s.trim().replace(/\s+/g, " ");
}

function phraseIn(phrase: string, textNorm: string): boolean {
  return Boolean(phrase) && ` ${textNorm} `.includes(` ${phrase} `);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortFormIn(form: string, rawText: string): boolean {
  if (!form) return false;
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(form)}(?![A-Za-z0-9])`);
  return re.test(rawText);
}

function goldForms(value: unknown, aliases: readonly string[]): string[] {
  const forms: string[] = [];
  if (value !== undefined && value !== null && String(value).trim()) {
    forms.push(String(value).trim());
  }
  for (const alias of aliases) {
    if (alias && alias.trim()) forms.push(alias.trim());
  }
  return forms;
}

function compactAlnum(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function stripLegal(value: unknown): string {
  return squadNorm(value)
    .split(" ")
    .filter((token) => token && !LEGAL_SUFFIXES.has(token))
    .join(" ");
}

function registrableDomain(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?:]/)[0]
    .replace(/^www\./, "");
  const parts = cleaned.split(".").filter(Boolean);
  if (parts.length <= 2) return cleaned;
  // Handle common two-label public suffixes (co.uk, com.au, co.jp, etc.)
  const lastTwo = parts.slice(-2).join(".");
  if (/^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

function parseAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const m = raw.match(/^(\()?\s*\$?\s*(-)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(trillion|billion|million|thousand|tn|bn|mn|mm|[tbmk])?\s*(\))?$/i);
  if (!m) {
    const n = Number(raw.replaceAll(",", ""));
    return Number.isFinite(n) ? n : null;
  }
  const num = Number(`${m[3].replaceAll(",", "")}${m[4] ? `.${m[4]}` : ""}`);
  if (!Number.isFinite(num)) return null;
  const scale = m[5] ? (AMOUNT_SCALES[m[5].toLowerCase()] ?? 1) : 1;
  const sign = m[2] || (m[1] && m[6]) ? -1 : 1;
  return sign * num * scale;
}

function extractTextAmounts(rawText: string): number[] {
  const results: number[] = [];
  const re = /(\()?[ \t]*((?<![\d.,])-)?[ \t]*([$€£¥])?[ \t]*((?<![\d.,])-)?[ \t]*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)[ \t]*(trillion|billion|million|thousand|tn|bn|mn|mm|[tbmk])?\b[ \t]*(\))?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rawText)) !== null) {
    const [full, parenOpen, signBefore, currency, signAfter, numStr, suffix, parenClose] = match;
    if (!numStr) continue;
    const base = Number(numStr.replaceAll(",", ""));
    if (!Number.isFinite(base)) continue;
    const yearLike = !currency && !suffix && !numStr.includes(",") && !numStr.includes(".") && base >= 1900 && base <= 2100;
    if (yearLike) continue;
    const scale = suffix ? (AMOUNT_SCALES[suffix.toLowerCase()] ?? 1) : 1;
    const sign = signBefore || signAfter || (parenOpen && parenClose) ? -1 : 1;
    results.push(sign * base * scale);
    // Avoid infinite loops on empty matches
    if (full.length === 0) re.lastIndex++;
  }
  return results;
}

export interface MatchExplanation {
  matched: boolean;
  matchedIn: "url" | "title" | "snippet" | "none";
  reason: string;
}

export function matchGoldEvidence(params: {
  field: string;
  fieldType?: string;
  value: unknown;
  aliases?: readonly string[];
  title: string;
  snippet: string;
  url: string;
  snippetChars?: number;
}): MatchExplanation {
  const {
    field,
    value,
    aliases = [],
    title,
    snippet,
    url,
    snippetChars = DEFAULT_SNIPPET_CHARS,
  } = params;
  const fieldType = params.fieldType ?? fieldTypeFor(field);
  const capped = capSnippet(snippet, snippetChars);
  const combined = titledSnippet(title, capped, snippetChars);
  const normCombined = squadNorm(combined);
  const cues = cuesFor(field);
  const forms = goldForms(value, aliases);
  const expectedLabel = forms[0] ?? String(value ?? "");

  if (cues.length > 0 && !cues.some((c) => phraseIn(squadNorm(c), normCombined))) {
    return {
      matched: false,
      matchedIn: "none",
      reason: `Missing required ${field} context cue (${cues.slice(0, 3).join(", ")}) in title/snippet.`,
    };
  }

  if (fieldType === "exact_id") {
    for (const form of forms) {
      const normId = form.replace(/[\s.-]/g, "").toUpperCase();
      if (normId.length < 2) continue;

      if (normId.length <= 6) {
        if (shortFormIn(normId, title)) {
          return { matched: true, matchedIn: "title", reason: `Matched exact ID ${normId} in title.` };
        }
        if (shortFormIn(normId, capped)) {
          return { matched: true, matchedIn: "snippet", reason: `Matched exact ID ${normId} in snippet.` };
        }
      } else {
        if (compactAlnum(title).includes(normId)) {
          return { matched: true, matchedIn: "title", reason: `Matched exact ${field.toUpperCase()} ${normId} in title.` };
        }
        if (compactAlnum(capped).includes(normId)) {
          return { matched: true, matchedIn: "snippet", reason: `Matched exact ${field.toUpperCase()} ${normId} in snippet.` };
        }
        if (compactAlnum(url).includes(normId)) {
          return { matched: true, matchedIn: "url", reason: `Matched exact ${field.toUpperCase()} ${normId} in URL.` };
        }
      }
    }
    return {
      matched: false,
      matchedIn: "none",
      reason: `Expected ${field.toUpperCase()} ${expectedLabel} not found in title, snippet (≤${snippetChars.toLocaleString()} chars), or URL.`,
    };
  }

  if (fieldType === "year") {
    const targetYears = new Set(forms.map((f) => Number.parseInt(f, 10)).filter(Number.isFinite));
    const check = (text: string): number | null => {
      const matches = text.match(/\b(1[5-9]\d{2}|20\d{2})\b/g) ?? [];
      for (const m of matches) {
        const y = Number.parseInt(m, 10);
        if (targetYears.has(y)) return y;
      }
      return null;
    };
    const inTitle = check(title);
    if (inTitle !== null) return { matched: true, matchedIn: "title", reason: `Matched year ${inTitle} in title.` };
    const inSnippet = check(capped);
    if (inSnippet !== null) return { matched: true, matchedIn: "snippet", reason: `Matched year ${inSnippet} in snippet.` };
    return { matched: false, matchedIn: "none", reason: `Expected year ${expectedLabel} not found in title or snippet.` };
  }

  if (fieldType === "domain") {
    const titleLower = title.toLowerCase();
    const snippetLower = capped.toLowerCase();
    for (const form of forms) {
      const dom = registrableDomain(form);
      if (!dom || !dom.includes(".")) continue;
      if (registrableDomain(url) === dom) {
        return { matched: true, matchedIn: "url", reason: `Matched domain ${dom} in result URL.` };
      }
      const re = new RegExp(`(?<![a-z0-9-])${escapeRegExp(dom)}(?![a-z0-9-])`);
      if (re.test(titleLower)) return { matched: true, matchedIn: "title", reason: `Matched domain ${dom} in title.` };
      if (re.test(snippetLower)) return { matched: true, matchedIn: "snippet", reason: `Matched domain ${dom} in snippet.` };
    }
    return { matched: false, matchedIn: "none", reason: `Expected domain ${expectedLabel} not found in URL, title, or snippet.` };
  }

  if (fieldType === "country") {
    const goldNorm = squadNorm(value);
    const canonical = RAW_COUNTRY_ALIASES[goldNorm] ?? goldNorm;
    const longForms = new Set<string>([canonical, goldNorm]);
    const shortForms = new Set<string>();
    for (const [k, v] of Object.entries(RAW_COUNTRY_ALIASES)) {
      if (v === canonical) {
        const kn = squadNorm(k);
        if (kn.replaceAll(" ", "").length <= 3) shortForms.add(kn.replaceAll(" ", "").toUpperCase());
        else longForms.add(kn);
      }
    }
    for (const a of aliases) {
      const an = squadNorm(a);
      if (an.replaceAll(" ", "").length <= 3) shortForms.add(a.trim());
      else if (an) longForms.add(an);
    }
    for (const [loc, raw] of [["title", title], ["snippet", capped]] as const) {
      const norm = squadNorm(raw);
      for (const f of longForms) {
        if (phraseIn(f, norm)) return { matched: true, matchedIn: loc, reason: `Matched country "${f}" in ${loc}.` };
      }
      for (const s of shortForms) {
        if (shortFormIn(s, raw)) return { matched: true, matchedIn: loc, reason: `Matched country code "${s}" in ${loc}.` };
      }
    }
    return { matched: false, matchedIn: "none", reason: `Expected country ${expectedLabel} not found in title or snippet.` };
  }

  if (fieldType === "person" || fieldType === "entity") {
    const check = (raw: string): string | null => {
      const norm = fieldType === "entity" ? stripLegal(raw) : squadNorm(raw);
      for (const f of forms) {
        const target = fieldType === "entity" ? stripLegal(f) : squadNorm(f);
        if (target && phraseIn(target, norm)) return f;
      }
      return null;
    };
    const inTitle = check(title);
    if (inTitle) return { matched: true, matchedIn: "title", reason: `Matched "${inTitle}" in title.` };
    const inSnippet = check(capped);
    if (inSnippet) return { matched: true, matchedIn: "snippet", reason: `Matched "${inSnippet}" in snippet.` };
    return { matched: false, matchedIn: "none", reason: `Expected ${fieldType} "${expectedLabel}" not found in title or snippet.` };
  }

  if (fieldType === "money" || fieldType === "numeric_band") {
    const relTol = fieldType === "money" ? MONEY_REL_TOL : HEADCOUNT_REL_TOL;
    const golds = forms.map(parseAmount).filter((n): n is number => n !== null);
    for (const [loc, raw] of [["title", title], ["snippet", capped]] as const) {
      const amounts = extractTextAmounts(raw);
      for (const gold of golds) {
        for (const amount of amounts) {
          const hit = gold === 0 ? Math.abs(amount) < 1 : Math.abs(amount - gold) / Math.abs(gold) <= relTol;
          if (hit) {
            return { matched: true, matchedIn: loc, reason: `Matched numeric value ${amount.toLocaleString()} (within ${(relTol * 100).toFixed(1)}% of ${gold.toLocaleString()}) in ${loc}.` };
          }
        }
      }
    }
    return { matched: false, matchedIn: "none", reason: `Expected numeric value ${expectedLabel} not found in title or snippet.` };
  }

  return { matched: false, matchedIn: "none", reason: `Unsupported field type: ${fieldType}.` };
}

export function firstHitRank(matches: readonly boolean[]): number | null {
  const idx = matches.findIndex(Boolean);
  return idx >= 0 ? idx + 1 : null;
}

export function computeRecallAndMrr(ranks: readonly (number | null)[]): {
  recall: number;
  mrr: number;
  hits: number;
  scored: number;
} {
  const scored = ranks.length;
  if (scored === 0) return { recall: 0, mrr: 0, hits: 0, scored: 0 };
  let hits = 0;
  let rrSum = 0;
  for (const r of ranks) {
    if (r !== null && r > 0) {
      hits += 1;
      rrSum += 1 / r;
    }
  }
  return {
    recall: hits / scored,
    mrr: rrSum / scored,
    hits,
    scored,
  };
}
