import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { capSnippet } from "../lib/needle-scorer";
import type { CorpusSearchHit, CorpusSnapshotRef } from "../lib/types";
import { findFetchedPassage } from "./passages";

export interface RankedResult {
  hit: CorpusSearchHit;
  snapshot: CorpusSnapshotRef;
}

function acceptedPath(directory: string) {
  return join(directory, "accepted-results.json");
}

export async function readAcceptedResults(directory: string): Promise<RankedResult[] | null> {
  const text = await readFile(acceptedPath(directory), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return text === null ? null : JSON.parse(text) as RankedResult[];
}

export async function validateRanking(
  rows: { url: string; title: string; snippet: string }[],
  candidates: RankedResult[], directory: string,
  sandbox: Parameters<typeof findFetchedPassage>[1], signal: AbortSignal, snippetChars: number,
) {
  const submitted = new Set<string>();
  const ranked: RankedResult[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [index, { url, title, snippet: requestedSnippet }] of rows.entries()) {
    const label = `Result ${index + 1}`;
    if (submitted.has(url)) {
      errors.push(`${label} repeats an earlier URL.`);
      continue;
    }
    submitted.add(url);
    const byUrl = candidates.filter(({ hit }) => hit.url === url);
    if (!byUrl.length) {
      errors.push(`${label} URL must come from corpus_search.`);
      continue;
    }
    const byTitle = byUrl.filter(({ hit }) => (hit.meta.title ?? "") === title);
    if (!byTitle.length) {
      errors.push(`${label} title must match the corpus_search result.`);
      continue;
    }
    const cappedSnippet = capSnippet(requestedSnippet, snippetChars);
    if (cappedSnippet !== requestedSnippet) warnings.push(`${label} snippet was capped to ${snippetChars} characters.`);
    const original = byTitle.find(({ hit }) => (hit.meta.description ?? "").includes(cappedSnippet));
    const source = original ? undefined : await findFetchedPassage(directory, sandbox, url, cappedSnippet, signal);
    const { snapshot, hit } = original ?? byTitle[0]!;
    const snippet = original || source ? cappedSnippet : capSnippet(hit.meta.description ?? "", snippetChars);
    if (!original && !source) {
      warnings.push(`${label} snippet could not be verified and was replaced with ${snippet ? "the indexed description" : "an empty string"}.`);
    }
    ranked.push({
      snapshot,
      hit: source ? { ...hit, passage: { snippet, source } } : { ...hit, meta: { ...hit.meta, description: snippet } },
    });
  }
  if (errors.length) return { error: errors.join("\n") };
  return { ranked, warnings };
}
