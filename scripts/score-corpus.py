# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["needle @ git+https://github.com/keenableai/needle.git@ca8aebdc6370ba0624e91c6c3594f4c051a5b343"]
# ///
"""Replay ranked Corpus evidence through the pinned NEEDLE evaluators."""
import argparse
import asyncio
import json
import os
import sys

from needle.finance.cli import _gold_query
from needle.finance.score import run_answers
from needle.legal.cli import _gold_legal
from needle.legal.score import run_legal
from needle.news.cli import _today_for_row
from needle.scholar.cli import _gold_paper
from needle.scholar.idconv import IdConverter
from needle.scholar.score import run_papers
from needle.shared.judge import DEFAULT_MAX_CONTENT_CHARS, QueryProfile, judge_one
from needle.shared.llm import OpenRouterClient
from needle.shared.rankeval import EvalQuery, _score_query
from needle.shared.search import SearchResult


class GatewayJudge(OpenRouterClient):
    """Use the archived judge model through the project's configured gateway."""

    async def _request(self, body):
        body["providerOptions"] = {"gateway": {"zeroDataRetention": True}}
        return await super()._request(body)


class ReplaySearch:
    """Supply each question's saved results in the order NEEDLE requests them."""

    engine = "corpus"
    reconnects = 0

    def __init__(self, rows):
        self.rows = iter(rows)
        self.latencies_ms = []

    async def search(self, query, *, num_results):
        row = next(self.rows)
        if query != row["source"]["query_text"]:
            raise ValueError("NEEDLE requested a different query than the next replay row")
        return [SearchResult(**doc) for doc in row["docs"][:num_results]], row.get("searchError")


async def score_rankings(batch, judge):
    """Use NEEDLE's query scorer with the original batch's profile and pooled ideal."""
    semaphore = asyncio.Semaphore(8)

    async def judge_doc(query, doc, profile):
        async with semaphore:
            judgement, _ = await judge_one(
                judge, query.text, url=doc.url, title=doc.title, published=doc.published_date,
                content=doc.snippet, today=query.today, profile=profile,
                max_content_chars=batch["snippetChars"] or DEFAULT_MAX_CONTENT_CHARS,
            )
        return judgement

    async def score_row(row):
        source = row["source"]
        today = batch["date"][:10]
        if batch["vertical"] == "news":
            today = _today_for_row(source, today)
        query = EvalQuery(text=source["query_text"], today=today)
        docs = [SearchResult(**doc) for doc in row["docs"][:batch["k"]]]
        profile = QueryProfile(**row["profile"]) if row["profile"] is not None else None
        error = row.get("searchError")
        judgements = [] if error is not None else await asyncio.gather(*(
            judge_doc(query, doc, profile) for doc in docs
        ))
        result = _score_query(query, docs, error, judgements,
                              k=batch["k"], profile=row["profile"], idcg=row["idcg"])
        result["score"] = result["ndcg"]
        return result

    return await asyncio.gather(*(score_row(row) for row in batch["questions"]))


async def score(batch):
    suite = batch["vertical"]
    rows = batch["questions"]
    client = None
    if batch.get("judgeModel") and suite in ("finance", "news", "agentic_rare"):
        client = GatewayJudge(api_key=os.environ["AI_GATEWAY_API_KEY"], model=batch["judgeModel"],
                              base_url="https://ai-gateway.vercel.sh/v1")
    try:
        if suite in ("news", "agentic_rare"):
            if client is None:
                raise ValueError(f"{suite} requires the archived NEEDLE judge model")
            return await score_rankings(batch, client)
        engines = {"corpus": ReplaySearch(rows)}
        options = {"num_results": batch["k"], "snippet_chars": batch["snippetChars"]}
        if suite == "finance":
            result = await run_answers([_gold_query(row["source"]) for row in rows], engines, judge=client, **options)
        elif suite == "legal":
            result = await run_legal([_gold_legal(row["source"]) for row in rows], engines, **options)
        elif suite == "scholar":
            converter = IdConverter()
            try:
                result = await run_papers([_gold_paper(row["source"]) for row in rows], engines, idconv=converter, **options)
            finally:
                await converter.aclose()
        else:
            raise ValueError(f"Unknown NEEDLE suite: {suite}")
        return result["engines"]["corpus"]["per_query"]
    finally:
        if client:
            await client.aclose()


def read_batch():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--retrieval", help="JSONL file with scoring settings followed by one result row per query")
    args = parser.parse_args()
    if not args.retrieval:
        return json.load(sys.stdin)
    with open(args.retrieval, encoding="utf-8") as records:
        batch = json.loads(next(records))
        batch["questions"] = [json.loads(line) for line in records]
        return batch


if __name__ == "__main__":
    print(json.dumps(asyncio.run(score(read_batch()))))
