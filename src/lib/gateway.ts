import type { DiscoveryIndexHit, DiscoveryOutcome } from "./types";

export function hasGatewayApiKey(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY?.trim());
}

/**
 * Offline lexical discovery fallback for `--no-llm` / keyless verification runs.
 */
export async function discoverCorpusLexical(params: {
  queryText: string;
  searchIndex: (indexQuery: string) => Promise<DiscoveryIndexHit[]>;
}): Promise<DiscoveryOutcome> {
  const { queryText, searchIndex } = params;
  const hits = await searchIndex(queryText);
  const top = hits[0] ?? null;
  return {
    status: top ? "found" : "not_found",
    mode: "index-lexical",
    model: null,
    indexQueries: [queryText],
    indexHits: hits,
    selectedCorpus: top ? top.corpus : null,
    resolvedTag: null,
    resolvedSnapshotId: null,
    reasoning: top
      ? `Lexical top-1 match on _/index:latest (${top.corpus}, score ${top.score.toFixed(2)}). Run with AI_GATEWAY_API_KEY for Eve retrieval and ranking.`
      : "No matching corpus returned by _/index:latest.",
    usage: null,
  };
}
