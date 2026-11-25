import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { capSnippet } from "../lib/needle-scorer";
import type { CorpusSearchHit, CorpusSnapshotRef } from "../lib/types";
import { findFetchedPassage } from "./passages";
import { readSessionSearches } from "./search-evidence";
import { questionDirectory } from "./session-files";

export const RESULTS_PATH = "/workspace/results.json";

interface RankedResult {
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

export function submitResultsTool(root: string, k: number, snippetChars: number, indexId: string) {
  const schema = z.array(z.strictObject({
    url: z.string().min(1),
    title: z.string(),
    snippet: z.string(),
  })).max(k);

  return defineTool({
    description: `Validate ${RESULTS_PATH} and submit it for scoring. Write the file first. Snippets are capped to ${snippetChars} characters. An unverifiable snippet is replaced with the indexed description, capped to that limit, or an empty string, preserving the URL and rank. If validation fails, fix the file and call this tool again. After it succeeds, finish.`,
    inputSchema: z.strictObject({}),
    async execute(_input, context) {
      const sandbox = await context.getSandbox();
      const signal = context.abortSignal;
      const text = await sandbox.readTextFile({ path: RESULTS_PATH, signal });
      if (text === null) return { error: `Write ${RESULTS_PATH} before submitting.` };
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return { error: `${RESULTS_PATH} must contain valid JSON.` };
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        return { error: parsed.error.issues.map(({ path, message }) =>
          `${RESULTS_PATH}${path.length ? ` at ${path.join(".")}` : ""}: ${message}`,
        ).join("\n") };
      }

      const directory = questionDirectory(root, context.session);
      const searches = await readSessionSearches(directory);
      const candidates = searches.filter(({ snapshot }) => snapshot.id !== indexId).flatMap(({ snapshot, hits }) => hits.map((hit) => ({ snapshot, hit })));
      const submitted = new Set<string>();
      const ranked: RankedResult[] = [];
      const errors: string[] = [];
      const warnings: string[] = [];
      for (const [index, { url, title, snippet: requestedSnippet }] of parsed.data.entries()) {
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
      const pending = join(directory, `${randomUUID()}.results.tmp`);
      await writeFile(pending, JSON.stringify(ranked));
      await rename(pending, acceptedPath(directory));
      return { submitted: true, count: ranked.length, ...(warnings.length ? { warnings } : {}) };
    },
  });
}
