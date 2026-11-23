import { runEveSuite } from "../eve/runner";
import { hasGatewayApiKey } from "../lib/gateway";
import { relevanceSuite } from "../lib/upstream";
import type {
  CorpusQABucketMetrics,
  CorpusQACompatibleArtifact,
  CorpusQACompatibleQuestionResult,
  CorpusQACompatibleOutcome,
} from "../lib/types";
import type { BenchmarkHarness, HarnessContext } from "./types";
import { rankedCorpusEvidence, scoreCorpusResults } from "./native-scoring";

/**
 * CorpusQA-Compatible Harness (Eve-powered, matching @corpusd/qa):
 * - Runs on `eve@1.0.0` with JustBashSandbox (`web_fetch`, `read_document` via Kreuzberg,
 *   `grep`, `read_file`, bounded `bash`, `web_search` disabled), 100k/16k token budget reserve,
 *   and native `typesafe-ai/jev` DecisionModel judging with 24 KiB excerpt retry.
 * - For Corpus: DeepSeek V4.1 Flash autonomously searches `_/index:latest` (`search_corpus_index`),
 *   attaches & searches discovered corpora (`corpus_search`), opens/reads sources, and answers
 *   (or fails immediately as C if no corpus is discovered/searched).
 */
export const corpusqaCompatibleHarness: BenchmarkHarness<CorpusQACompatibleArtifact> = {
  id: "corpusqa-compatible",
  label: "CorpusQA-Compatible (Eve)",
  description:
    "Purely agentic Eve (@corpusd/qa parity) harness: DeepSeek V4.1 Flash + JustBashSandbox + native typesafe-ai/jev DecisionModel judge.",
  artifactFilename: "corpusqa-compatible.json",

  async run(ctx: HarnessContext): Promise<CorpusQACompatibleArtifact> {
    const { config, upstream, cliVersion, indexSnapshot, skipLlm, simulateMisses } = ctx;
    const retrievalOnly = relevanceSuite(upstream.vertical);
    const executedAt = new Date().toISOString();
    const rubric =
      "CorpusQA Eve A/B/C accuracy via typesafe-ai/jev DecisionModel (A = Correct, B = Incorrect, C = Not attempted; only A passes).";

    if (!simulateMisses && (skipLlm || !hasGatewayApiKey())) {
      console.log(
        `[harness:corpusqa-compatible] Skipping Eve execution (${skipLlm ? "--no-llm" : "AI_GATEWAY_API_KEY not set"}); recording pending_gateway_key.`,
      );
      return {
        harness: "corpusqa-compatible",
        status: "pending_gateway_key",
        executedAt,
        note: `Set AI_GATEWAY_API_KEY (Node.js >= 24 required for Eve) and run \`bun run bench:run --harness corpusqa-compatible\` (or \`bun run bench:refresh --upgrade-pending\`) to execute Eve + ${config.models.agent} + ${config.models.judge} via Vercel AI Gateway.`,
        agentModel: config.models.agent,
        judgeModel: config.models.judge,
        zeroDataRetention: config.models.zeroDataRetention,
        rubric,
        comparedProviders: [],
        corpusCliVersion: cliVersion,
        indexSnapshot,
        resolvedCorpora: {},
        providers: [],
        questions: [],
      };
    }

    const suiteBase = ["needle", upstream.vertical, ctx.slice].filter(Boolean).join("-");
    const simulatedOutcome: CorpusQACompatibleOutcome | null = simulateMisses ? {
      engine: "corpus",
      verdict: retrievalOnly ? "ungraded" : "C",
      passed: false,
      answer: "",
      reasoning: "Failed to find a relevant corpus.",
      discoveryFailed: true,
      indexQueries: [],
      selectedCorpora: [],
      searchQueries: [],
      fetchedUrls: [],
      testedAt: executedAt,
      agentModel: config.models.agent,
      judgeModel: config.models.judge,
      usage: { agent: null, judge: null },
    } : null;

    const corpusRun = simulateMisses ? null : await runEveSuite({
      suite: `${suiteBase}-corpus`,
      cases: upstream.queries.map((q) => ({
        index: q.index,
        queryId: q.queryId,
        question: q.queryText,
        answer: retrievalOnly ? null : q.goldValue,
      })),
      indexSnapshot,
      k: upstream.k,
      registry: config.corpusRegistry,
      agentModel: config.models.agent,
      judgeModel: config.models.judge,
    });

    const questions: CorpusQACompatibleQuestionResult[] = [];
    const byBucket: Record<string, CorpusQABucketMetrics> = {};
    let correct = 0;
    let incorrect = 0;
    let notAttempted = 0;
    let errors = 0;
    let discoveryHits = 0;
    let testedAt: string | null = null;

    for (const q of upstream.queries) {
      const outcome = simulatedOutcome ?? corpusRun?.outcomesByIndex.get(q.index);
      const outcomes: CorpusQACompatibleQuestionResult["outcomes"] = {};
      if (outcome) outcomes.corpus = outcome;
      const evidence = corpusRun?.retrievalByIndex.get(q.index);
      questions.push({
        queryId: q.queryId,
        index: q.index,
        outcomes,
        ...(corpusRun ? { retrieval: {
          engine: "corpusqa",
          hitRank: null,
          detRank: null,
          queriedAt: outcome?.testedAt ?? null,
          searchError: evidence ? null : "CorpusQA evidence collection failed.",
          ...(evidence
            ? { timing: evidence.timing }
            : { unscoredReason: "CorpusQA did not return a valid evidence list." }),
          results: rankedCorpusEvidence(upstream, evidence?.hits ?? []),
        } } : {}),
      });
      const bucket = (byBucket[q.bucket] ??= {
        accuracy: 0,
        correct: 0,
        incorrect: 0,
        notAttempted: 0,
        errors: 0,
        total: 0,
      });
      bucket.total += 1;

      if (outcome) {
        if (!outcome.discoveryFailed) discoveryHits += 1;
        if (!testedAt || outcome.testedAt < testedAt) testedAt = outcome.testedAt;
      }

      switch (outcome?.verdict) {
        case "A":
          correct += 1;
          bucket.correct += 1;
          break;
        case "B":
          incorrect += 1;
          bucket.incorrect += 1;
          break;
        case "C":
          notAttempted += 1;
          bucket.notAttempted += 1;
          break;
        case "ungraded":
          break;
        default:
          errors += 1;
          bucket.errors += 1;
      }
    }

    for (const bucket of Object.values(byBucket)) {
      bucket.accuracy = bucket.correct / bucket.total;
    }

    const total = upstream.queries.length;
    const accuracy = total ? correct / total : 0;
    await scoreCorpusResults(upstream, questions.flatMap(({ index, retrieval }) =>
      retrieval && !retrieval.unscoredReason ? [{ index, corpusNeedle: retrieval }] : []));
    console.log(
      `[harness:corpusqa-compatible] ${retrievalOnly ? "Ranked evidence scored without an answer grade." : `Corpus Accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${total})`}`,
    );

    return {
      harness: "corpusqa-compatible",
      status: "completed",
      executedAt,
      note: corpusRun
        ? `Executed with Eve ${corpusRun.eveVersion} (@corpusd/qa parity): ${config.models.agent} + JustBashSandbox + ${config.models.judge} DecisionModel via Vercel AI Gateway (ZDR enabled).`
        : "Simulated abstention after failing to find a relevant corpus for every question.",
      agentModel: config.models.agent,
      judgeModel: config.models.judge,
      zeroDataRetention: config.models.zeroDataRetention,
      rubric,
      comparedProviders: [],
      corpusCliVersion: cliVersion,
      indexSnapshot,
      resolvedCorpora: corpusRun?.resolvedCorpora ?? {},
      providers: retrievalOnly ? [] : [
        {
          engine: "corpus",
          displayName: "Corpus",
          isCorpus: true,
          accuracy,
          correct,
          incorrect,
          notAttempted,
          errors,
          total,
          discoveryHits,
          discoveryTotal: total,
          testedAt,
          agentModel: config.models.agent,
          judgeModel: config.models.judge,
          byBucket,
        },
      ],
      questions,
    };
  },
};
