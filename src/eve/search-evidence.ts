import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CorpusClient } from "../lib/corpus-cli";
import type { CorpusSearchHit, CorpusSnapshotRef } from "../lib/types";
import type { RequestOptions } from "../lib/corpus-mcp";

export interface SearchEvidence {
  snapshot: CorpusSnapshotRef;
  query: string;
  hits: CorpusSearchHit[];
  searchMs: number;
}

export function sessionPath(root: string, sessionId: string) {
  return join(root, encodeURIComponent(sessionId));
}

function searchDirectory(directory: string) {
  return join(directory, "searches");
}

export async function readSessionSearches(directory: string): Promise<SearchEvidence[]> {
  const filenames = await readdir(searchDirectory(directory)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(filenames.filter((name) => name.endsWith(".json")).sort().map(async (name) => (
    JSON.parse(await readFile(join(searchDirectory(directory), name), "utf8")) as SearchEvidence
  )));
}

export async function searchWithEvidence(
  client: CorpusClient,
  snapshot: CorpusSnapshotRef,
  query: string,
  k: number,
  directory: string,
  callId: string,
  options?: RequestOptions,
): Promise<CorpusSearchHit[]> {
  const start = performance.now();
  const hits = (await client.search(snapshot.id, query, k, options)).slice(0, k);
  const searchMs = performance.now() - start;
  const path = searchDirectory(directory);
  await mkdir(path, { recursive: true });
  const pending = join(path, `${randomUUID()}.tmp`);
  await writeFile(pending, JSON.stringify({ snapshot, query, hits, searchMs }));
  await rename(pending, join(path, `${encodeURIComponent(callId)}.json`));
  return hits;
}
