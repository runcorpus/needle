import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { CorpusClient } from "../lib/corpus-cli";
import type { CorpusSnapshotRef } from "../lib/types";
import type { RequestOptions } from "../lib/corpus-socket";
import { completeLeadingPassage } from "./web-fetch";
import { isFinalizing } from "./budget";
import { validateRanking, type RankedResult } from "./results";
import { readSessionSearches, searchWithEvidence, type SearchEvidence } from "./search-evidence";
import { questionDirectory, writeRecord } from "./session-files";
import { activeTraceContext } from "./trace-context";

const query = z.string().trim().min(1).max(1000);
const recoverySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("catalog"), query, reason: query }),
  z.strictObject({ kind: z.literal("documents"), ref: z.string(), query, reason: query }),
]);
export type Recovery = z.infer<typeof recoverySchema>;
export type Phase = "discover" | "retrieve" | "select-recovery" | "rank" | "rerank" | "finish";
export interface Selection {
  refs: string[];
  traceContext?: RequestOptions["traceContext"];
}
export interface Ranking {
  ranked: RankedResult[];
  recovery?: Recovery;
  traceContext?: RequestOptions["traceContext"];
}

export async function phase(directory: string): Promise<Phase> {
  return JSON.parse(await readFile(join(directory, "phase.json"), "utf8"));
}

export function candidatePool(searches: SearchEvidence[], indexId: string) {
  const pool = new Map<string, RankedResult>();
  for (const { snapshot, hits } of searches) {
    if (snapshot.id === indexId) continue;
    for (const hit of hits) {
      const id = createHash("sha256").update(hit.url).digest("hex").slice(0, 16);
      if (!pool.has(id)) pool.set(id, { hit, snapshot });
    }
  }
  return pool;
}

export function decisionTools(root: string, index: CorpusSnapshotRef, k: number, snippetChars: number, rewrite: boolean) {
  const select = defineTool({
    description: "Submit the exact meta.corpus references of relevant collections from this discovery step. Use [] if none fit.",
    inputSchema: z.strictObject({ refs: z.array(z.string()) }),
    async execute({ refs }, ctx) {
      const dir = questionDirectory(root, ctx.session);
      const stage = await phase(dir);
      if (ctx.session.parent || (stage !== "discover" && stage !== "select-recovery")) {
        return { error: "Only the parent can select collections during discovery." };
      }
      const searches = await readSessionSearches(dir);
      const recoveryQuery = stage === "select-recovery" ? JSON.parse(await readFile(join(dir, "recovery-query.json"), "utf8")) : null;
      const lookups = searches.filter(s => s.snapshot.id === index.id && (stage === "discover" || s.query === recoveryQuery));
      const allowed = new Set(lookups.flatMap(s => s.hits.map(hit => hit.meta.corpus)));
      if (refs.some(ref => !allowed.has(ref))) return { error: "Select exact meta.corpus references from the current catalog results." };
      await writeRecord(dir, stage + "-decision", { refs: isFinalizing() ? [] : [...new Set(refs)], traceContext: activeTraceContext() });
      return { selected: true };
    },
  });
  const rank = defineTool({
    description: "Record the ordered candidate IDs and verbatim snippets. Omit recovery to finish.",
    inputSchema: z.strictObject({
      results: z.array(z.strictObject({ id: z.string(), snippet: z.string() })).max(k),
      recovery: recoverySchema.optional(),
    }),
    async execute({ results, recovery }, ctx) {
      const dir = questionDirectory(root, ctx.session);
      const stage = await phase(dir);
      if (ctx.session.parent || (stage !== "rank" && stage !== "rerank")) {
        return { error: "Only the parent can record the current ranking." };
      }
      const searches = await readSessionSearches(dir);
      const documents = searches.filter(s => s.snapshot.id !== index.id);
      if (recovery && !isFinalizing()) {
        if (stage !== "rank") return { error: "Recovery was already used." };
        if (recovery.kind === "documents" && (!rewrite || !documents.some(s => s.snapshot.ref === recovery.ref))) {
          return { error: "A rewrite requires Agent mode and a previously searched document collection." };
        }
        const repeated = searches.some(s => s.query === recovery.query && (recovery.kind === "catalog"
          ? s.snapshot.id === index.id : s.snapshot.ref === recovery.ref));
        if (repeated) return { error: "This search was already tried. Choose a different lead or finish." };
      }
      const pool = candidatePool(searches, index.id);
      const rows = [];
      for (const { id, snippet } of results) {
        const candidate = pool.get(id);
        if (!candidate) return { error: "Unknown candidate ID: " + id };
        rows.push({ url: candidate.hit.url, title: candidate.hit.meta.title ?? "", snippet });
      }
      const evidence = documents.flatMap(({ snapshot, hits }) => hits.map(hit => ({ snapshot, hit })));
      const sandbox = await ctx.getSandbox();
      const result = await validateRanking(rows, evidence, dir, sandbox, ctx.abortSignal, snippetChars);
      if ("error" in result) return { error: result.error };
      const lead = result.ranked[0]?.hit;
      if (rewrite && !recovery && !isFinalizing() && lead) {
        try {
          const passage = await completeLeadingPassage(root, index.id, lead, snippetChars, ctx);
          if (passage) lead.passage = passage;
        } catch {
          ctx.abortSignal.throwIfAborted();
          result.warnings.push("Could not complete the leading snippet from its source.");
        }
      }
      await writeRecord(dir, stage + "-decision", { ranked: result.ranked, recovery: isFinalizing() ? undefined : recovery, traceContext: activeTraceContext() });
      return { recorded: true, warnings: result.warnings };
    },
  });
  return { select, rank };
}

export async function retrieve(
  client: CorpusClient, directory: string, refs: string[], query: string, k: number,
  pins: Record<string, CorpusSnapshotRef>, options: RequestOptions, pass: string,
) {
  const searched = new Set((await readSessionSearches(directory)).filter(s => s.query === query).map(s => s.snapshot.id));
  for (const [i, ref] of refs.entries()) {
    const paired = pins[ref] ?? Object.values(pins).find(s => s.ref.split(":")[0] === ref);
    const snapshot = paired ? await client.attachPinned(paired, options) : await client.attachAndInfo(ref, options);
    if (searched.has(snapshot.id)) continue;
    searched.add(snapshot.id);
    await writeRecord(join(directory, "attachments"), snapshot.ref, snapshot);
    await searchWithEvidence(client, snapshot, query, k, directory, pass + "-" + i, options);
  }
}
