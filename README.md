# Corpus NEEDLE Benchmark

[needle.corpusd.dev](https://needle.corpusd.dev/)

This benchmark compares Corpus against live web search APIs on queries from Keenable’s
[NEEDLE](https://keenableai.github.io/needle/). For each question, an [Eve](https://eve.dev/)
agent running DeepSeek V4.1 Flash checks the Library index (`_/index`) to pick a relevant
corpus and searches it through the Corpus CLI. This gives us a fast-model baseline.

**Corpus (NEEDLE)** searches with the original query verbatim at the published depth, then
ranks the URLs it finds. We use NEEDLE’s metrics to compare the ranking with the published
provider scores.

**Corpus (Agent)** can rewrite the query before searching. It returns the same ranked URL
format and uses the same retrieval depth and NEEDLE scoring as Corpus (NEEDLE).

NEEDLE is Keenable’s public benchmark; this mirror exists solely to track Corpus performance and
guide development priorities.

## Appendix

### How Corpus searches

Both variants give Eve the original NEEDLE question. Eve discovers relevant corpus in the
Library with `index_search` and retrieves evidence with `corpus_search`. It can keep searching
within its token budget until it has enough evidence to rank the results.

Corpus (NEEDLE) sends the question verbatim to each corpus it searches. Corpus (Agent) can
rewrite the query on each search. Paired runs use the same model and Library index snapshot
and reuse the same snapshot for every corpus both variants search.

Both variants return `{"urls": [...]}` with up to *K* distinct retrieved URLs in relevance
order. The grader receives the original question and ranked evidence, including titles,
snippets, and publication dates when available.

Eve uses a 64,000-token context window and cumulative limits of 200,000 input and 32,768
output tokens per question. It allows up to 4,096 output tokens per research call and
reserves up to 16,384 for the final ranking. When Eve switches to the final ranking, it
stops tool calls and returns the ranked URLs. It runs up to four questions concurrently,
with a five-minute timeout per question.

### How each suite is scored

Both variants use the same pinned upstream NEEDLE evaluator for each suite.

- **Finance** checks for answer evidence in the top results, using NEEDLE’s fallback judge
  when the batch enables it.
- **Scholar** checks whether the results include the target paper.
- **Legal** checks whether the results include the target case or regulation.
- **News and AgenticRare** grade ranking quality with nDCG@5, using the batch’s recorded judge
  model and query profile and normalizing against its *Ultimate* ranking.

Ultimate pools results from the original providers. Both Corpus variants are compared with
the same published provider scores.

### How seven-day results are calculated

Corpus averages scored questions from measured full batches in the seven-day window. A
suite’s 95% confidence interval requires at least two distinct batches and two distinct
questions. Overall averages the five suites’ shares of Ultimate, with zero for suites
without results. Its interval requires at least two batches in all five suites.

### Latest full runs

The [homepage appendix](https://needle.corpusd.dev/#appendix) and
[Markdown report](https://needle.corpusd.dev/results.md) link to the latest published full
run for each suite. Each run includes per-question results and downloadable artifacts.

### Data attribution

The [NEEDLE benchmark results](https://huggingface.co/datasets/keenable-ai/needle-results)
from Keenable AI are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Corpus selects published batches, adds its own retrieval results and scores, and computes
seven-day summaries. This repository’s code is licensed under [MIT](./LICENSE).
