import { capSnippet } from "../lib/needle-scorer";
import type { CorpusSearchHit, ProviderQueryResult } from "../lib/types";
import { relevanceSuite, type ParsedBatch } from "../lib/upstream";

interface CorpusScore {
  score: number | null;
  hit_rank?: number | null;
  det_rank?: number | null;
  ndcg?: number | null;
  judge_errors?: number;
  results: Array<{ matched?: boolean; det_match?: boolean; judge_match?: boolean | null; rating?: number | null; reasoning?: string | null }>;
}

export function rankedCorpusEvidence(upstream: ParsedBatch, hits: CorpusSearchHit[]) {
  return hits.map((hit, index) => ({
    rank: index + 1,
    url: hit.url,
    title: hit.meta.title ?? "",
    snippet: capSnippet(hit.meta.description ?? "", upstream.snippetChars),
    score: Number(hit.score.toFixed(4)),
    meta: hit.meta,
    detMatch: false,
    judgeMatch: null,
    matchedIn: "none" as const,
    matchReason: "",
  }));
}

export function isAccountError(err: string | null | undefined): boolean {
  if (!err) return false;
  return /\b(401|402|403|429|432|433)\b|credit|quota|billing|spend limit|api[_ ]key/i.test(err);
}

export async function scoreCorpusResults(
  upstream: ParsedBatch,
  questions: { index: number; corpusNeedle: ProviderQueryResult }[],
  judgeModel = upstream.judgeModel,
) {
  if (!questions.length) return;
  const relevance = relevanceSuite(upstream.vertical);
  const payload = {
    vertical: upstream.vertical, k: upstream.k, snippetChars: upstream.snippetChars,
    date: upstream.runDateIso, judgeModel,
    questions: questions.map(({ index, corpusNeedle }) => {
      const oracle = upstream.perEngine.ultimate?.[index];
      if (relevance && !oracle) throw new Error("Published nDCG ideal missing");
      const errorType = corpusNeedle.searchError
        ? isAccountError(corpusNeedle.searchError) ? "account_error" : "api_error"
        : null;
      return {
        source: upstream.sourceRows[index],
        docs: corpusNeedle.results.map(({ url, title, snippet, meta }) => ({
          url, title, snippet: typeof meta?.description === "string" ? meta.description : snippet,
          published_date: typeof meta?.published_date === "string" ? meta.published_date : undefined,
        })),
        idcg: oracle?.ndcg === 1 ? oracle.dcg : null, profile: oracle?.query_profile ?? null,
        searchError: errorType
          ? { error_type: errorType, error_message: corpusNeedle.searchError }
          : null,
      };
    }),
  };
  const proc = Bun.spawn(["uv", "run", "--python", "3.12", "--script", "scripts/score-corpus.py"], {
    env: { ...process.env },
    stdin: new Blob([JSON.stringify(payload)]), stdout: "pipe", stderr: "inherit",
  });
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`Native ${upstream.vertical} scoring failed (exit ${code})`);
  const scores: CorpusScore[] = JSON.parse(output);
  if (scores.length !== questions.length) throw new Error("NEEDLE scorer returned a different number of results than requested.");
  for (const [i, { corpusNeedle }] of questions.entries()) {
    const score = scores[i];
    if (relevance) corpusNeedle.ndcg = score.ndcg ?? null;
    if (score.score !== null) delete corpusNeedle.unscoredReason;
    else if (!corpusNeedle.unscoredReason) {
      corpusNeedle.unscoredReason = score.judge_errors ? "NEEDLE judge did not complete." : "No scored published ideal for this query.";
    }
    if (score.results.length !== corpusNeedle.results.length) throw new Error("NEEDLE returned a different number of results than supplied.");
    for (const [j, result] of corpusNeedle.results.entries()) {
      const grade = score.results[j];
      result.detMatch = grade.det_match ?? grade.matched ?? false;
      result.judgeMatch = grade.judge_match ?? null;
      if (relevance) {
        result.rating = grade.rating ?? null;
        result.matchReason = grade.reasoning ?? (result.rating === null ? corpusNeedle.unscoredReason ?? "" : `NEEDLE relevance rating ${result.rating}/4.`);
      } else if (result.judgeMatch) {
        result.matchReason = "NEEDLE Finance fallback judge matched the expected answer.";
      } else {
        result.matchReason = result.detMatch ? "NEEDLE matched the reference." : "NEEDLE found no match.";
      }
    }
    corpusNeedle.hitRank = score.hit_rank ?? null;
    corpusNeedle.detRank = score.det_rank === undefined ? corpusNeedle.hitRank : score.det_rank;
  }
}
