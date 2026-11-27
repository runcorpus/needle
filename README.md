# Corpus NEEDLE Benchmark

[needle.corpusd.dev](https://needle.corpusd.dev/)

This benchmark compares Corpus against live web search APIs on queries from Keenable’s
[NEEDLE](https://keenableai.github.io/needle/). For each question, an [Eve](https://eve.dev/)
agent running DeepSeek V4.1 Flash checks the Library index (`_/index`) to pick a relevant
corpus and searches it through the local Corpus daemon. This gives us a fast-model baseline.

**Corpus (NEEDLE)** searches with the original query verbatim at the published depth, then
ranks the URLs it finds. We use NEEDLE’s metrics to compare the ranking with the published
provider scores.

**Corpus (Agent)** receives the suite's broad research scope, such as legal research, and can
rewrite a document query during recovery. It returns the same ranked URL format and uses the same
retrieval depth and NEEDLE scoring as Corpus (NEEDLE).

NEEDLE is Keenable’s public benchmark; this mirror exists solely to track Corpus performance and
guide development priorities.

## Appendix

### How Corpus searches

Each question runs in one Eve session over the local Corpus daemon. The TypeScript
controller runs these steps:

1. **Discover.** Eve searches the Library catalog with `corpus_search` and submits
   relevant references from the returned metadata using `select_collections`.
2. **Retrieve.** The controller resolves the published tags and searches the selected
   snapshots with the original question and the batch's published retrieval depth.
3. **Rank.** Eve orders candidate IDs across collections, supplies source snippets and
   may request one targeted recovery with a reason.
4. **Recover.** A new catalog lookup can lead to another collection search. Agent mode
   can instead rewrite one previously searched collection's document query. Eve ranks
   the combined pool. Recovery shares the question's time and token budgets.
5. **Finish.** The controller returns up to *K* distinct, validated URLs. The artifact
   records the first ranking and, when recovery ran, its query, reason and elapsed time.

Install the Corpus CLI before running locally. The benchmark starts the daemon when
needed and records the local CLI version and resolved snapshots.

Eve's default `agent` delegation is available. Delegated tasks share their question's
virtual attachments, evidence, and JustBash sandbox; other questions and modes keep
separate attachments. Socket requests forward Eve's active trace context and cancellation.
Eve traces remain in `.evals/traces/`. The daemon records detailed search traces in
`$CORPUS_HOME/traces/corpusd.jsonl` by default; matching trace IDs link the two.
Actions saves both in a `needle-traces-<suite>-<mode>` artifact for 14 days,
including failed runs, with signed URL parameters removed.

Corpus (Agent) also receives suite-level project context for Legal, Finance, Scholar, News,
or rare and obscure topics. For Legal, the context is "The user is conducting legal research.
Their question is legal-related." Corpus (NEEDLE) receives the original question without
suite-level context. Agent run outputs record the supplied scope.

Both variants can freely phrase catalog searches. Corpus (NEEDLE) sends the question verbatim
to document collections. Corpus (Agent) can rewrite document queries. Paired runs use the
same model and Library index snapshot and reuse the same snapshot for every corpus both
variants search. Either variant can discover and attach additional published collections.

The parent submits ordered IDs and snippets through `record_ranking`. The controller
resolves IDs against the question's retrieved documents, validates copied snippets against
indexed or fetched evidence, and sends titles, URLs, snippets and available publication
dates to the upstream evaluator.

Each completed question is checkpointed immediately. Repeating the same local command
or retrying the Actions job restores matching completed questions and retries missing
or failed ones. Checkpoints pin the Library index and searched collections; changes to
questions, model settings, or retrieval code invalidate incompatible results. Actions
uploads checkpoints while the run is in progress, so completed work can survive a
runner timeout. A full batch is published only after the run finishes.

Eve uses a 64,000-token context window and cumulative limits of 200,000 input and 32,768
output tokens per question. It allows up to 4,096 output tokens per research call and
reserves up to 16,384 for the final ranking. When Eve switches to the final ranking, it
ends new searches and allows evidence inspection and submission. It runs up to four questions concurrently,
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
