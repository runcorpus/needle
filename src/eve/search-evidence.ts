import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CorpusClient } from "../lib/corpus-cli";
import type { CorpusSearchHit, CorpusSnapshotRef } from "../lib/types";

export interface SearchEvidence {
  snapshot: CorpusSnapshotRef;
  query: string;
  hits: CorpusSearchHit[];
  searchMs: number;
}

export function sessionPath(root: string, sessionId: string) {
  return join(root, encodeURIComponent(sessionId));
}

export async function searchWithEvidence(
  client: CorpusClient,
  snapshot: CorpusSnapshotRef,
  query: string,
  k: number,
  directory: string,
  callId: string,
): Promise<CorpusSearchHit[]> {
  const start = performance.now();
  const hits = (await client.search(snapshot.id, query, k)).slice(0, k);
  const searchMs = performance.now() - start;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${encodeURIComponent(callId)}.json`), JSON.stringify({ snapshot, query, hits, searchMs }));
  return hits;
}
