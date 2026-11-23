import { runNeedleEveSuite } from "../eve/runner";
import type { CorpusClient } from "../lib/corpus-cli";
import {
  discoverCorpusLexical,
  hasGatewayApiKey,
} from "../lib/gateway";
import {
  capSnippet,
  computeRecallAndMrr,
  firstHitRank,
  matchGoldEvidence,
} from "../lib/needle-scorer";
import type {
  BucketMetrics,
  CorpusSearchHit,
  CorpusSnapshotRef,
  DiagnosticCheck,
  DiscoveryOutcome,
  NeedleCompatibleArtifact,
  NeedleCompatibleProviderSummary,
  NeedleCompatibleQuestionResult,
  ProviderQueryResult,
  RankedEvidence,
  RetrievalHarnessId,
} from "../lib/types";
import { rankedCorpusEvidence, scoreCorpusResults } from "./native-scoring";
import { applyPublishedProviderMetrics, providerDisplayName, relevanceSuite } from "../lib/upstream";
import type { BenchmarkHarness, HarnessContext } from "./types";

function isAccountError(err: string | null): boolean {
  if (!err) return false;
  return /\b(401|402|403|429|432|433)\b|credit|quota|billing|api[_ ]key/i.test(err);
}

async function runMicrosoftLeiDiagnostic(
  corpus: CorpusClient,
  gleifRef: CorpusSnapshotRef,
  k: number,
  snippetChars: number,
): Promise<DiagnosticCheck> {
  const goldLei = "INR2EJN1ERAN0W5ZP974";
  const probes = [
    { label: "NEEDLE keyword wording", queryText: "microsoft lei code" },
    { label: "NEEDLE natural-language wording", queryText: "what is the lei code of microsoft" },
    { label: "Entity legal name wording", queryText: "Microsoft Corporation" },
  ];

  const queries = [];
  for (const probe of probes) {
    const hits = await corpus.search(gleifRef.id, probe.queryText, k);
    const ranked: RankedEvidence[] = hits.map((h, i) => {
      const snippet = capSnippet(h.meta.description ?? "", snippetChars);
      const exp = matchGoldEvidence({
        field: "lei",
        fieldType: "exact_id",
        value: goldLei,
        title: h.meta.title ?? "",
        snippet,
        url: h.url,
        snippetChars,
      });
      return {
        rank: i + 1,
        url: h.url,
        title: h.meta.title ?? "",
        snippet,
        score: Number(h.score.toFixed(4)),
        meta: h.meta,
        detMatch: exp.matched,
        judgeMatch: null,
        matchedIn: exp.matchedIn,
        matchReason: exp.reason,
      };
    });
    queries.push({
      label: probe.label,
      queryText: probe.queryText,
      hitRank: firstHitRank(ranked.map((r) => r.detMatch)),
      results: ranked,
    });
  }

  return {
    title: "Microsoft Corporation LEI Diagnostic",
    description:
      "Direct wording sensitivity check on the pinned GLEIF snapshot comparing NEEDLE's original keyword and natural-language templates against the canonical legal name.",
    goldValue: goldLei,
    corpusRef: `${gleifRef.ref} (${gleifRef.id.slice(0, 12)})`,
    queries,
  };
}

function retrievalHarness(id: RetrievalHarnessId): BenchmarkHarness<NeedleCompatibleArtifact> {
  const allowQueryRewrite = id === "agent";
  const corpusEngine = allowQueryRewrite ? "corpus-agent" : "corpus";
  const label = allowQueryRewrite ? "Corpus (Agent)" : "Corpus (NEEDLE)";
  const queryMethod = allowQueryRewrite ? "an original or rewritten query" : "the verbatim NEEDLE query";
  async function run(ctx: HarnessContext): Promise<NeedleCompatibleArtifact> {
    const { config, upstream, slice, corpus, cliVersion, indexSnapshot, skipLlm, simulateMisses, pinnedCorpora } = ctx;
    const relevance = relevanceSuite(upstream.vertical);
    const useEve = !simulateMisses && !skipLlm && hasGatewayApiKey();
    const discoveryMode = simulateMisses ? "simulated" : useEve ? "eve" : "index-lexical";
    const executedAt = new Date().toISOString();
    const resolvedCorpora: Record<string, CorpusSnapshotRef> = {};
    const questions: NeedleCompatibleQuestionResult[] = [];

    console.log(
      `[harness:${id}] Preparing ${upstream.queries.length} queries (retrieval=${useEve ? config.models.agent : discoveryMode})...`,
    );

    const simulatedDiscovery: DiscoveryOutcome = {
      status: "not_found",
      mode: "simulated",
      model: null,
      indexQueries: [],
      indexHits: [],
      selectedCorpus: null,
      resolvedTag: null,
      resolvedSnapshotId: null,
      reasoning: "Failed to find a relevant corpus.",
      usage: null,
    };
    const eveResults = useEve ? await runNeedleEveSuite({
      suite: `needle-${upstream.vertical}-${allowQueryRewrite ? "agent" : "retrieval"}`,
      cases: upstream.queries.map(({ index, queryText }) => ({ index, queryText })),
      indexSnapshot,
      registry: config.corpusRegistry,
      agentModel: config.models.agent,
      zeroDataRetention: config.models.zeroDataRetention,
      k: config.searchK,
      snippetChars: config.snippetChars,
      allowQueryRewrite,
      pinnedCorpora,
    }) : null;

    for (const q of upstream.queries) {
      const eveResult = eveResults?.get(q.index);
      const corpusQueriedAt = eveResult?.queriedAt ?? new Date().toISOString();
      let discovery: DiscoveryOutcome;
      let hits: CorpusSearchHit[] = [];
      let corpusError: string | null = null;

      if (eveResult) {
        discovery = eveResult.discovery;
        hits = eveResult.hits;
        for (const snapshot of eveResult.snapshots) resolvedCorpora[snapshot.ref] = snapshot;
        if (discovery.status === "error") corpusError = discovery.reasoning;
      } else if (simulateMisses) {
        discovery = simulatedDiscovery;
      } else {
        if (useEve) throw new Error(`Eve did not return a result for query ${q.queryId}.`);
        discovery = await discoverCorpusLexical({
          queryText: q.queryText,
          searchIndex: (iq) => corpus.searchIndex(indexSnapshot.id, iq, config.searchK),
        });
        if (discovery.selectedCorpus) {
          try {
            const snapshot = await corpus.attachAndInfo(discovery.selectedCorpus);
            resolvedCorpora[discovery.selectedCorpus] = snapshot;
            discovery.resolvedTag = snapshot.ref;
            discovery.resolvedSnapshotId = snapshot.id;
            hits = await corpus.search(snapshot.id, q.queryText, config.searchK);
          } catch (err) {
            corpusError = err instanceof Error ? err.message : String(err);
            if (!discovery.resolvedSnapshotId) {
              discovery.status = "error";
              discovery.reasoning = `Failed to attach ${discovery.selectedCorpus}: ${corpusError}`;
            }
          }
        }
      }
      if (discovery.status === "not_found") corpusError = `Discovery missed: ${discovery.reasoning}`;

      const corpusRanked = rankedCorpusEvidence(upstream, hits);
      const corpusNeedle: ProviderQueryResult = {
        engine: corpusEngine,
        hitRank: null,
        detRank: null,
        searchError: corpusError,
        queriedAt: corpusQueriedAt,
        ...(eveResult?.timing ? { timing: eveResult.timing } : {}),
        ...(corpusError && discovery.status !== "not_found" ? { unscoredReason: corpusError } : {}),
        results: corpusRanked,
      };

      // Keep archived match flags, with local explanations for legacy Finance slices.
      const providersNeedle: Record<string, ProviderQueryResult> = {};
      for (const engine of upstream.engines) {
        const row = upstream.perEngine[engine]?.[q.index];
        if (!row) continue;
        const results: RankedEvidence[] = (row.results ?? [])
          .slice(0, config.searchK)
          .map((r, idx) => {
            const snippet = capSnippet(r.snippet ?? "", config.snippetChars);
            const archivedMatch = r.det_match ?? r.matched;
            const match = upstream.vertical === "finance" && (slice || archivedMatch === undefined) ? matchGoldEvidence({
              field: q.field,
              fieldType: q.fieldType,
              value: q.goldValue,
              aliases: q.goldAliases,
              title: r.title ?? "",
              snippet,
              url: r.url ?? "",
              snippetChars: config.snippetChars,
            }) : null;
            const detMatch = archivedMatch ?? match?.matched ?? false;
            const matchReason =
              detMatch && !match?.matched && upstream.vertical === "finance"
                ? `Upstream deterministic match recorded for ${q.field.toUpperCase()} ${q.goldValue}.`
                : !detMatch && r.judge_match === true
                  ? `Missed deterministic check; upgraded by upstream LLM judge.`
                  : match?.reason ?? r.reasoning ??
                    (detMatch ? "Published item identity match." : "No published match.");
            return {
              rank: idx + 1,
              url: r.url ?? "",
              title: r.title ?? "",
              snippet,
              detMatch,
              judgeMatch: r.judge_match ?? null,
              ...(relevance ? { rating: r.rating ?? null } : {}),
              matchedIn: detMatch ? (match?.matchedIn ?? "none") : "none",
              matchReason,
            };
          });

        const detRank = firstHitRank(results.map((r) => r.detMatch));
        providersNeedle[engine] = {
          engine,
          hitRank: row.hit_rank === undefined ? detRank : row.hit_rank,
          detRank: row.det_rank === undefined ? detRank : row.det_rank,
          ...(row.score === null ? { unscoredReason: "No published score for this query." } : {}),
          searchError: typeof row.search_error === "object" && row.search_error ? JSON.stringify(row.search_error) : row.search_error,
          ...(relevance ? { ndcg: row.ndcg ?? null } : {}),
          queriedAt: row.queried_at ?? upstream.runDateIso,
          results,
        };
      }

      questions.push({
        queryId: q.queryId,
        index: q.index,
        discovery,
        corpusNeedle,
        providersNeedle,
      });
    }

    if (simulateMisses) {
      if (relevance) {
        for (const { index, corpusNeedle } of questions) {
          const ideal = upstream.perEngine.ultimate?.[index];
          corpusNeedle.ndcg = ideal?.ndcg === 1 && ideal.dcg ? 0 : null;
        }
      }
    } else {
      await scoreCorpusResults(
        upstream,
        questions,
        useEve ? upstream.judgeModel : "",
      );
    }

    // Aggregate provider summaries
    const allEngines = [corpusEngine, ...upstream.engines];
    const providers: NeedleCompatibleProviderSummary[] = allEngines.map((engine) => {
      const isCorpus = engine === corpusEngine;
      const isUltimate = engine === "ultimate";
      let serviceErrors = 0;
      let accountErrors = 0;
      let judgeUpgrades = 0;
      let earliestTs: string | null = null;
      const scoredRanks: (number | null)[] = [];
      const byBucketRanks: Record<string, (number | null)[]> = {};
      const byBucketTotals: Record<string, number> = {};

      for (let i = 0; i < upstream.queries.length; i++) {
        const q = upstream.queries[i];
        const qRes = questions[i];
        const res = isCorpus ? qRes.corpusNeedle : qRes.providersNeedle[engine];
        byBucketTotals[q.bucket] = (byBucketTotals[q.bucket] ?? 0) + 1;

        if (!res) {
          scoredRanks.push(null);
          (byBucketRanks[q.bucket] ??= []).push(null);
          continue;
        }
        if (res.queriedAt && (!earliestTs || res.queriedAt < earliestTs)) {
          earliestTs = res.queriedAt;
        }
        const publishedScore = !isCorpus && !relevance ? upstream.perEngine[engine]?.[i]?.score : undefined;
        if (publishedScore === null || (isCorpus && res.unscoredReason)) continue;
        if (publishedScore === undefined && !isCorpus && res.searchError) {
          if (isAccountError(res.searchError)) {
            accountErrors += 1;
            continue;
          }
          serviceErrors += 1;
          scoredRanks.push(null);
          (byBucketRanks[q.bucket] ??= []).push(null);
          continue;
        }
        if (res.hitRank !== null && res.detRank !== res.hitRank) {
          judgeUpgrades += 1;
        }
        const rank = res.hitRank;
        scoredRanks.push(rank);
        (byBucketRanks[q.bucket] ??= []).push(rank);
      }

      const overall = computeRecallAndMrr(scoredRanks);
      const byBucket: Record<string, BucketMetrics> = {};
      for (const [bucket, total] of Object.entries(byBucketTotals)) {
        byBucket[bucket] = { ...computeRecallAndMrr(byBucketRanks[bucket] ?? []), total };
      }

      const summary: NeedleCompatibleProviderSummary = {
        engine,
        displayName: isCorpus && allowQueryRewrite ? label : providerDisplayName(engine),
        isCorpus,
        isUltimate,
        recallAtK: relevance ? null : overall.recall,
        mrrAtK: relevance ? null : overall.mrr,
        pctOfUltimate: null,
        hits: relevance ? null : overall.hits,
        scored: overall.scored,
        total: upstream.queries.length,
        serviceErrors,
        accountErrors,
        judgeUpgrades,
        testedAt: earliestTs ?? (isCorpus ? executedAt : upstream.runDateIso),
        byBucket: relevance ? {} : byBucket,
      };

      if (relevance) {
        const scores = questions.flatMap((q) => {
          const result = isCorpus ? q.corpusNeedle : q.providersNeedle[engine];
          return typeof result?.ndcg === "number" ? [result.ndcg] : [];
        });
        summary.meanNdcg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        summary.scored = scores.length;
      }
      const published = !isCorpus && !slice ? upstream.publishedMetrics[engine] : undefined;
      if (published) applyPublishedProviderMetrics(summary, published);
      if (isCorpus) {
        const discovered = questions.filter((r) => r.discovery.status === "found");
        const inCorpus = computeRecallAndMrr(discovered.filter((r) => !r.corpusNeedle.unscoredReason).map((r) => r.corpusNeedle.hitRank));
        summary.discoveryHits = discovered.length;
        summary.discoveryTotal = questions.length;
        summary.inCorpusRecallAtK = !relevance && discovered.length > 0 ? inCorpus.recall : null;
      }

      return summary;
    });

    const ultimateRow = providers.find((p) => p.isUltimate);
    const ultimateRecallAtK = ultimateRow?.recallAtK ?? null;
    const ultimateMrrAtK = ultimateRow?.mrrAtK ?? null;
    for (const p of providers) {
      p.pctOfUltimate = ultimateRecallAtK && p.recallAtK != null ? p.recallAtK / ultimateRecallAtK : null;
    }

    providers.sort((a, b) => {
      if (a.isUltimate !== b.isUltimate) return a.isUltimate ? -1 : 1;
      if (relevance) return (b.meanNdcg ?? -1) - (a.meanNdcg ?? -1);
      if (b.recallAtK !== a.recallAtK) return (b.recallAtK ?? -1) - (a.recallAtK ?? -1);
      if (b.mrrAtK !== a.mrrAtK) return (b.mrrAtK ?? -1) - (a.mrrAtK ?? -1);
      return a.displayName.localeCompare(b.displayName);
    });

    const diagnostics: DiagnosticCheck[] = [];
    const gleifSnapshot = Object.values(resolvedCorpora).find(({ ref }) => ref.startsWith("gleif/lei:"));
    if (!allowQueryRewrite && !simulateMisses && upstream.vertical === "finance" && (slice === "lei" || gleifSnapshot)) {
      const gleifSnap = gleifSnapshot ?? (await corpus.attachAndInfo("gleif/lei"));
      if (!gleifSnapshot) resolvedCorpora["gleif/lei"] = gleifSnap;
      diagnostics.push(
        await runMicrosoftLeiDiagnostic(corpus, gleifSnap, config.searchK, config.snippetChars),
      );
    }

    const corpusRow = providers.find((p) => p.isCorpus)!;
    const metric = relevance ? `nDCG@${upstream.k}=${corpusRow.meanNdcg ?? "unscored"}` : `Recall@${upstream.k}=${corpusRow.recallAtK}`;
    console.log(`[harness:${id}] Corpus ${metric} (${corpusRow.scored} scored queries)`);

    return {
      harness: id,
      status: "completed",
      executedAt,
      method: simulateMisses ? "Simulated failure to find a relevant corpus for every query." : relevance
        ? `Eve-ranked Corpus URLs graded with NEEDLE's ${upstream.judgeModel} rubric against the published pooled ideal.`
        : `${useEve ? `Eve ranks URLs retrieved with ${queryMethod}` : "Verbatim NEEDLE retrieval"} with NEEDLE's top-${upstream.k} ${upstream.vertical} evidence scoring.`,
      k: config.searchK,
      snippetChars: config.snippetChars,
      discoveryMode,
      discoveryModel: useEve ? config.models.agent : null,
      ...(simulateMisses ? {} : { grading: "needle" as const }),
      corpusCliVersion: cliVersion,
      indexSnapshot,
      resolvedCorpora,
      ultimateRecallAtK,
      ultimateMrrAtK,
      providers,
      questions,
      diagnostics,
    };
  }

  return {
    id,
    label,
    description: `Eve discovers corpora, searches using ${queryMethod} at the published depth, and ranks retrieved URLs for NEEDLE scoring.`,
    artifactFilename: `${id}.json`,
    run,
  };
}

export const needleCompatibleHarness = retrievalHarness("needle-compatible");
export const agentHarness = retrievalHarness("agent");
