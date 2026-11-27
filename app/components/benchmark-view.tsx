"use client";

import { Input } from "@ui-sdk/react/input";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { corpusAgent as corpusAgentLabel, corpusNeedle as needleLabel, type CorpusReportMode } from "@/lib/report-results";
import type {
  RunBundle,
  RunIndexEntry,
  NeedleCompatibleProviderSummary,
  ProviderQueryResult,
  RankedEvidence,
  DiscoveryOutcome,
} from "@/lib/types";
import { BenchmarkPeriodToggle, type BenchmarkPeriod } from "./benchmark-period";
import { CorpusModeMark } from "./corpus-mode-mark";
import { LeaderboardTable, type LeaderboardTableProps } from "./leaderboard-table";
import { RetrievalTokenCost } from "./retrieval-token-cost";
import { SuiteNav, suites } from "./suite-nav";
import { LocalTime, ReportCaption } from "./local-time";

function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function RetrievalScore({ summary, relevance }: {
  summary?: NeedleCompatibleProviderSummary;
  relevance: boolean;
}) {
  const score = relevance ? summary?.meanNdcg : summary?.recallAtK;
  return (
    <td className="num">
      {summary && summary.scored > 0 && score != null ? (
        <>
          <strong>{relevance ? score.toFixed(3) : pct(score)}</strong>
          <div className="text-xs text-(--ui-muted-foreground)">
            {relevance ? `${summary.scored} scored` : `${summary.hits}/${summary.scored} hits`}
          </div>
        </>
      ) : <span className="text-xs text-(--ui-muted-foreground)">{summary ? "Unscored" : "Pending"}</span>}
    </td>
  );
}

function bucketLabel(bucket: string): string {
  if (bucket === "finance") return "Keyword";
  if (bucket === "finance_nl") return "Natural language";
  if (bucket === "filings") return "SEC filings";
  if (bucket === "filingdoc") return "SEC document";
  if (bucket === "caselaw") return "Caselaw";
  if (bucket === "code") return "CFR";
  if (bucket === "rss") return "RSS";
  if (bucket === "agentic_rare") return "AgenticRare";
  if (bucket === "title") return "Title";
  if (bucket === "body") return "Body";
  if (bucket === "clue") return "Clue";
  if (bucket === "tot") return "ToT";
  return bucket;
}

function isDiscoveryMissError(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith("Discovery missed:");
}

function retrievalOutcome(
  result: ProviderQueryResult | null | undefined,
  k: number,
  useHitRank = true,
  discovery?: DiscoveryOutcome | null,
) {
  if (!result) return { label: "Not run", style: "badge--neutral" };
  if (result.unscoredReason) return { label: "Unscored", style: "badge--neutral" };
  if (discovery?.status === "not_found" || isDiscoveryMissError(result.searchError)) {
    return { label: "No relevant corpus", style: "badge--miss" };
  }
  if (result.ndcg !== undefined) return { label: result.ndcg === null ? "Unscored" : `nDCG ${result.ndcg.toFixed(3)}`, style: "badge--neutral" };
  if (result.searchError) return { label: "Search error", style: "badge--warn" };
  const rank = useHitRank ? result.hitRank : result.detRank;
  if (rank !== null) return { label: `Hit at #${rank}`, style: "badge--hit" };
  return { label: `Top-${k} miss`, style: "badge--miss" };
}

function selectedCorpus(discovery: DiscoveryOutcome | null) {
  if (!discovery) return "No recorded route";
  if (discovery.status === "error") return "Routing error";
  if (discovery.searchedCorpora?.length) return discovery.searchedCorpora.join(", ");
  return discovery.resolvedTag ?? discovery.selectedCorpus ?? "No relevant corpus";
}

function EvidenceList({
  title,
  subtitle,
  result,
  k,
  mode,
  published,
  discovery,
}: {
  title: string;
  subtitle: string;
  result: ProviderQueryResult | null | undefined;
  k: number;
  mode?: CorpusReportMode;
  published?: boolean;
  discovery?: DiscoveryOutcome | null;
}) {
  const { label, style } = retrievalOutcome(result, k, published, discovery);
  const isCorpus = mode !== undefined;
  const results = result?.results ?? [];
  const rawError = result?.unscoredReason ?? result?.searchError;
  const error = isDiscoveryMissError(rawError) ? null : rawError;
  return (
    <div className="panel-box">
      <div className="panel-header">
        <div>
          <h3 className={mode ? "report-engine text-(--corpus-ink)" : undefined}>
            {mode && <CorpusModeMark mode={mode} />}
            {title}
          </h3>
          <div className="text-[11px] text-(--ui-muted-foreground)">{subtitle}</div>
        </div>
        <span className={`badge ${style}`}>{label}</span>
      </div>

      <div className="space-y-2 p-3">
        {error && (
          <div className="border border-(--miss-border) bg-(--miss-soft) px-3 py-2 text-xs text-(--miss-ink)">
            {typeof error === "string" ? error : JSON.stringify(error)}
          </div>
        )}
        {results.length === 0 && !error && (
          <div className="py-4 text-center text-xs text-(--ui-muted-foreground)">{result ? "No results returned." : "No saved result for this question."}</div>
        )}
        {results.map((item) => (
          <div
            key={`${item.rank}-${item.url}`}
            className={`evidence-card ${item.detMatch || item.judgeMatch === true ? "evidence-card--hit" : ""}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="mono text-xs text-(--ui-muted-foreground)">#{item.rank}</span>
                {item.rating !== undefined ? (
                  <span className="badge badge--neutral">{item.rating == null ? "Unrated" : `Relevance ${item.rating}/4`}</span>
                ) : item.detMatch ? (
                  <span className="badge badge--hit">{item.matchedIn === "none" ? "Identity match" : `Hit · ${item.matchedIn}`}</span>
                ) : item.judgeMatch === true ? (
                  <span className={`badge ${isCorpus ? "badge--hit" : "badge--warn"}`}>{isCorpus ? "Judge hit" : "Upstream judge hit"}</span>
                ) : (
                  <span className="badge badge--neutral">Miss</span>
                )}
              </div>
              {typeof item.score === "number" && (
                <span className="mono text-[11px] text-(--ui-muted-foreground)">
                  score {item.score.toFixed(2)}
                </span>
              )}
            </div>

            <div className="mt-1.5 font-medium text-(--ui-foreground) break-words">
              {item.title || "(untitled)"}
            </div>

            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="mono mt-0.5 block truncate text-[11px] text-(--ui-ring) hover:underline"
              >
                {item.url}
              </a>
            )}

            {item.snippet && (
              <p className="mt-1.5 line-clamp-4 text-xs text-(--ui-prose) whitespace-pre-wrap break-words">
                {item.snippet}
              </p>
            )}

            {item.meta && typeof item.meta.lei === "string" && (
              <div className="mono mt-1.5 text-[11px] text-(--ui-muted-foreground)">
                meta.lei: <span className="text-(--ui-foreground)">{item.meta.lei}</span>
                {typeof item.meta.country === "string" ? ` · ${item.meta.country}` : ""}
                {typeof item.meta.entity_status === "string" ? ` · ${item.meta.entity_status}` : ""}
              </div>
            )}

            <div className="mt-2 border-t border-(--ui-border) pt-1.5 text-[11px] text-(--ui-muted-foreground)">
              {item.matchReason}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BenchmarkView({ bundle, runs, startDate, weeklyLeaderboard }: {
  bundle: RunBundle;
  runs: RunIndexEntry[];
  startDate: string;
  weeklyLeaderboard?: LeaderboardTableProps & { caption: string; latestRunAt?: string | null };
}) {
  const router = useRouter();
  const { manifest, needleCompatible, agent, questions } = bundle;
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [period, setPeriod] = useState<BenchmarkPeriod>("latest");
  const showWeekly = period === "weekly" && weeklyLeaderboard !== undefined;

  const [searchTerm, setSearchTerm] = useState("");
  const [bucketFilter, setBucketFilter] = useState<string>("all");
  const [selectedIdx, setSelectedIdx] = useState<number>(questions[0]?.index ?? 0);

  const needleProviders = (needleCompatible ?? agent)?.providers ?? [];

  const comparableProviders = useMemo(
    () =>
      needleProviders
        .filter((p) => !p.isCorpus && !p.isUltimate),
    [needleProviders],
  );
  const [compareEngine, setCompareEngine] = useState<string>(
    comparableProviders.find((p) => p.engine === "keenable-realtime")?.engine ??
      comparableProviders[0]?.engine ??
      "exa",
  );

  const provider = comparableProviders.find((p) => p.engine === compareEngine) ?? comparableProviders[0];
  const corpusNeedle = needleCompatible?.providers.find((p) => p.isCorpus);
  const corpusAgent = agent?.providers.find((p) => p.isCorpus);

  const buckets = useMemo(() => [...new Set(questions.map((q) => q.bucket))], [questions]);

  const filteredQuestions = useMemo(() => {
    const qLower = searchTerm.trim().toLowerCase();
    return questions.filter((q) => {
      if (bucketFilter !== "all" && q.bucket !== bucketFilter) return false;
      if (!qLower) return true;
      return (
        q.queryText.toLowerCase().includes(qLower) ||
        q.goldValue.toLowerCase().includes(qLower) ||
        (q.provenance.entity ?? "").toLowerCase().includes(qLower)
      );
    });
  }, [questions, searchTerm, bucketFilter]);

  const activeQuestion =
    filteredQuestions.find((q) => q.index === selectedIdx) ??
    filteredQuestions[0];
  const file = activeQuestion?.evidenceFile;
  const [evidence, setEvidence] = useState<{ file: string; rows?: Record<string, RankedEvidence[]> }>();
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    fetch(file, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Missing evidence");
        const rows = await response.json();
        if (!controller.signal.aborted) setEvidence({ file, rows });
      })
      .catch(() => { if (!controller.signal.aborted) setEvidence({ file }); });
    return () => controller.abort();
  }, [file]);
  function withEvidence(result: ProviderQueryResult | null | undefined) {
    if (!result || !file || evidence?.file !== file || !evidence.rows) return result;
    return { ...result, results: evidence.rows[result.engine] ?? result.results };
  }
  const evidenceReady = !file || (evidence?.file === file && evidence.rows);
  const activeRetrieval = withEvidence(activeQuestion?.corpusNeedle);
  const agentRetrieval = withEvidence(activeQuestion?.corpusAgent);
  const agentDiscovery = activeQuestion?.agentDiscovery;
  const agentOutcome = retrievalOutcome(agentRetrieval, manifest.k, true, agentDiscovery);
  const providerResult = provider && withEvidence(activeQuestion?.providersNeedle[provider.engine]);
  const showPublishedGrade = !manifest.slice || (needleCompatible ?? agent)?.grading === "needle";
  const providerOutcome = retrievalOutcome(providerResult, manifest.k, showPublishedGrade);
  const discoveryMissed = activeQuestion?.discovery?.status === "not_found";
  const activeRetrievalOutcome = retrievalOutcome(activeRetrieval, manifest.k, true, activeQuestion?.discovery);

  const relevance = manifest.vertical === "news" || manifest.vertical === "agentic_rare";
  const retrievalMetric = relevance ? `nDCG@${manifest.k}` : `Recall@${manifest.k}`;
  const displayedProviders = showAllProviders ? comparableProviders : comparableProviders.slice(0, 5);
  const ultimate = needleProviders.find((p) => p.isUltimate);
  const detailedProviders = useMemo(() => {
    const merged = [...needleProviders];
    if (corpusAgent && !merged.some((p) => p.engine === corpusAgent.engine)) {
      merged.push(corpusAgent);
    }
    return merged.sort((a, b) => {
      if (a.isUltimate !== b.isUltimate) return a.isUltimate ? -1 : 1;
      if (relevance) return (b.meanNdcg ?? -1) - (a.meanNdcg ?? -1);
      if (b.recallAtK !== a.recallAtK) return (b.recallAtK ?? -1) - (a.recallAtK ?? -1);
      if (b.mrrAtK !== a.mrrAtK) return (b.mrrAtK ?? -1) - (a.mrrAtK ?? -1);
      return a.displayName.localeCompare(b.displayName);
    });
  }, [needleProviders, corpusAgent, relevance]);
  const retrievalRows = [
    ...(agent || !manifest.slice ? [{ id: "corpus-agent", name: corpusAgentLabel, summary: corpusAgent }] : []),
    {
      id: "corpus",
      name: needleLabel,
      summary: corpusNeedle,
    },
    ...displayedProviders.map((p) => ({
      id: p.engine,
      name: p.displayName,
      summary: p,
    })),
    ...(ultimate ? [{ id: ultimate.engine, name: "Ultimate (published ceiling)", summary: ultimate }] : []),
  ];

  const resolvedCorporaList = Object.entries(manifest.corpus.resolvedCorpora);
  const suiteLabel = suites.find(({ id }) => id === manifest.vertical)?.label ?? manifest.vertical;
  const batchLabel = manifest.sampleSize ? "Local run" : manifest.slice ? `${manifest.slice.toUpperCase()} slice` : "Full batch";
  const questionLabel = manifest.queryCount === 1 ? "question" : "questions";
  const selectedRun = runs.find((run) => run.id === manifest.id)?.id ?? "";

  const harness = agent ? (needleCompatible ? "both" : "agent") : "needle-compatible";
  const runCommand = `bun run bench:run --run ${manifest.upstreamRunId} --vertical ${manifest.vertical} --harness ${harness}${manifest.slice ? ` --slice ${manifest.slice}` : ""}${manifest.sampleSize ? ` --sample ${manifest.sampleSize}` : ""}`;
  const recordedVersion = manifest.corpus.cliVersion.trim().replace(/^corpus\s+/i, "");
  const releaseVersion = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(recordedVersion)
    ? recordedVersion
    : null;
  const reproCommands = [
    releaseVersion ? `# 1. Install Corpus CLI ${releaseVersion}` : "# 1. Install Corpus CLI",
    `curl -fsSL https://runcorpus.com/install.sh | sh${releaseVersion ? ` -s -- ${releaseVersion}` : ""}`,
    `corpus daemon start`,
    ``,
    `# 2. Attach pinned Corpus Index & resolved snapshot(s)`,
    `corpus add ${manifest.corpus.indexRef}   # sha256: ${manifest.corpus.indexSnapshot.id.slice(0, 16)}`,
    ...resolvedCorporaList.map(
      ([, snap]) => `corpus add ${snap.ref}   # sha256: ${snap.id.slice(0, 16)}`,
    ),
    ``,
    `# 3. Run this benchmark`,
    `export AI_GATEWAY_API_KEY=<your-vercel-ai-gateway-key>`,
    runCommand,
  ].join("\n");

  return (
    <>
      <div className="guide-toolbar report-column">
        <nav className="guide-nav" aria-label="Benchmark sections">
          <a className="guide-link" href="#leaderboard">Results</a>
          <a className="guide-link" href="#questions">Questions</a>
          <a className="guide-link" href="#reproduce">Appendix</a>
        </nav>

        <div className="flex flex-wrap items-center gap-2">
          <span className="badge badge--neutral">{batchLabel}</span>
          {runs.length > 0 ? (
            <>
              <label className="sr-only" htmlFor="run-selector">Select benchmark run</label>
              <select
                id="run-selector"
                className="native-select"
                value={selectedRun}
                onChange={(e) => router.push(`/runs/${e.target.value}`)}
              >
                {selectedRun ? null : <option value="" disabled>Choose a run</option>}
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.upstreamRunId} · {r.sampleSize ? "Local run" : r.slice ? `${r.slice.toUpperCase()} slice` : "Full batch"} ({r.queryCount}q)
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </div>
      </div>
      <SuiteNav current={manifest.vertical} />

      <main>
        <section id="overview" className="report-overview report-column">
          <h1 className="report-title">{suiteLabel}</h1>
          <p className="report-run-date">
            {manifest.queryCount} {questionLabel} · {batchLabel} ·{" "}
            <a href={manifest.upstreamUrl} target="_blank" rel="noreferrer" className="text-(--ui-ring) hover:underline">
              Published NEEDLE batch ↗
            </a>{" "}· <LocalTime iso={manifest.upstreamRunDate} />
          </p>
          <p>
            For each question in this batch, the agent checks <code>_/index</code> to pick a relevant corpus.{" "}
            <strong>Corpus (NEEDLE)</strong> searches with the original query. <strong>Corpus (Agent)</strong> can
            rewrite it. Both return ranked URLs for NEEDLE scoring. Provider scores come from the same published batch.
          </p>
          {manifest.sampleSize && (
            <p>
              This preview covers the first{" "}
              {manifest.queryCount === 1 ? "question" : `${manifest.queryCount} questions`} from the batch.
            </p>
          )}
        </section>

        <section id="leaderboard" className="report-section report-column">
          <div className="report-results-heading">
            <h2 className="report-section-heading">Quality results</h2>
            {weeklyLeaderboard && <BenchmarkPeriodToggle period={period} onChange={setPeriod} />}
          </div>
          {showWeekly && (
            <>
              <p className="report-source-date">NEEDLE providers · <ReportCaption caption={weeklyLeaderboard.caption} latestRunAt={weeklyLeaderboard.latestRunAt} /></p>
              <div className="panel-box">
                <LeaderboardTable {...weeklyLeaderboard} />
              </div>
            </>
          )}
          {!showWeekly && manifest.vertical === "finance" && !manifest.slice && !agent && needleCompatible?.discoveryMode !== "eve" && comparableProviders.some((p) => p.judgeUpgrades > 0) && (
            <p className="mb-3 text-sm text-(--ui-muted-foreground)">
              Corpus Finance recall is scored with NEEDLE’s exact matcher only, whereas this batch’s provider scores
              also include LLM-judged matches.
            </p>
          )}
          <div className="panel-box overflow-x-auto" hidden={showWeekly}>
            <table className="data-table results-table">
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col" className="num">{retrievalMetric}</th>
                </tr>
              </thead>
              <tbody>
                {retrievalRows.map(({ id, name, summary }) => {
                  const mode = id === "corpus-agent" ? "agent" : id === "corpus" ? "needle" : null;
                  return (
                    <tr key={id} className={summary?.isUltimate ? "row--ultimate" : mode ? "row--corpus" : undefined}>
                      <th scope="row" className={mode ? "result--corpus" : undefined}>
                        {mode ? <span className="report-engine"><CorpusModeMark mode={mode} />{name}</span> : name}
                      </th>
                      <RetrievalScore summary={summary} relevance={relevance} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {comparableProviders.length > 5 && <button
              type="button"
              aria-expanded={showAllProviders}
              className="w-full cursor-pointer border-t border-(--ui-border) px-4 py-2 text-left text-xs text-(--ui-ring) hover:underline"
              onClick={() => setShowAllProviders((v) => !v)}
            >
              {showAllProviders ? "Show fewer providers" : `Show all ${comparableProviders.length} published providers`}
            </button>}
          </div>
          {(needleCompatible || agent) && !relevance && <details className="trace-detail mt-3" hidden={showWeekly}>
            <summary>Retrieval metrics by provider</summary>
            <div className="panel-box overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Provider</th>
                      <th className="num">Recall@{manifest.k}</th>
                      <th className="num">MRR@{manifest.k}</th>
                      <th className="num">% Ultimate</th>
                      <th className="num">Hits</th>
                      {buckets.map((b) => (
                        <th key={b} className="num">{bucketLabel(b)}</th>
                      ))}
                      <th className="num">Errors</th>
                      <th>Tested</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailedProviders.map((p) => {
                      const rankIdx = detailedProviders
                        .filter((x) => !x.isUltimate)
                        .findIndex((x) => x.engine === p.engine);
                      const providerName = p.engine === "corpus-agent"
                        ? corpusAgentLabel
                        : p.isCorpus
                          ? needleLabel
                          : p.displayName;
                      return (
                        <tr
                          key={p.engine}
                          className={
                            p.isCorpus
                              ? "row--corpus"
                              : p.isUltimate
                                ? "row--ultimate"
                                : ""
                          }
                        >
                          <td className="mono text-(--ui-muted-foreground)">
                            {p.isUltimate ? "★" : rankIdx + 1}
                          </td>
                          <td className="font-medium">
                            <span
                              className={
                                p.isCorpus
                                  ? "report-engine text-(--corpus-ink)"
                                  : p.isUltimate
                                    ? "text-(--ui-ring)"
                                    : ""
                              }
                            >
                              {p.isCorpus && <CorpusModeMark mode={p.engine === "corpus-agent" ? "agent" : "needle"} />}
                              {providerName}
                            </span>
                            {p.isCorpus && (
                              <span className="badge badge--hit ml-2">Local Corpus</span>
                            )}
                            {p.isUltimate && (
                              <span className="badge badge--ultimate ml-2">Pooled Ceiling</span>
                            )}
                          </td>
                          <td className="num font-semibold">{pct(p.recallAtK)}</td>
                          <td className="num">{p.mrrAtK?.toFixed(3) ?? "—"}</td>
                          <td className="num text-(--ui-muted-foreground)">{pct(p.pctOfUltimate)}</td>
                          <td className="num">
                            {p.hits}/{p.scored}
                          </td>
                          {buckets.map((b) => (
                            <td key={b} className="num">
                              {p.byBucket[b]
                                ? `${p.byBucket[b].hits}/${p.byBucket[b].scored}`
                                : "—"}
                            </td>
                          ))}
                          <td className="num text-(--ui-muted-foreground)">
                            {p.serviceErrors + p.accountErrors > 0
                              ? `${p.serviceErrors}s/${p.accountErrors}a`
                              : "0"}
                          </td>
                          <td className="mono text-xs text-(--ui-muted-foreground)">{p.testedAt ? <LocalTime iso={p.testedAt} compact /> : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
            </div>
          </details>}
        </section>

        {!showWeekly && <RetrievalTokenCost questions={questions} localUsage={bundle.localUsage} isLocal={Boolean(manifest.sampleSize)} />}

        {/* Question & Evidence Inspector */}
        <section id="questions">
          <h2 className="section-heading">Compare by question</h2>
          {showWeekly && <p className="report-source-date">Questions and evidence from the latest full batch.</p>}

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="w-full max-w-xs">
              <Input
                value={searchTerm}
                onValueChange={(v) => setSearchTerm(v)}
                placeholder="Filter by question or expected answer…"
                aria-label="Filter benchmark questions"
              />
            </div>

            <select
              className="native-select"
              value={bucketFilter}
              onChange={(e) => setBucketFilter(e.target.value)}
              aria-label="Filter by category"
            >
              <option value="all">All categories ({questions.length})</option>
              {buckets.map((b) => (
                <option key={b} value={b}>
                  {bucketLabel(b)}
                </option>
              ))}
            </select>

            {comparableProviders.length > 0 && (
              <div className="ml-auto flex items-center gap-2 text-xs text-(--ui-muted-foreground)">
                <label htmlFor="compare-provider">Published provider</label>
                <select
                  id="compare-provider"
                  className="native-select"
                  value={provider?.engine ?? ""}
                  onChange={(e) => setCompareEngine(e.target.value)}
                >
                  {comparableProviders.map((p) => (
                    <option key={p.engine} value={p.engine}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="inspector-grid">
            <div className="inspector-list" role="listbox" aria-label="Benchmark questions">
              {filteredQuestions.length === 0 && (
                <div className="p-4 text-xs text-(--ui-muted-foreground)">No matching questions.</div>
              )}
              {filteredQuestions.map((q) => {
                const active = activeQuestion?.index === q.index;
                const retrieval = retrievalOutcome(q.corpusNeedle, manifest.k, true, q.discovery);
                const agentItem = q.corpusAgent && retrievalOutcome(q.corpusAgent, manifest.k, true, q.agentDiscovery);
                return (
                  <button
                    key={q.queryId}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-active={active}
                    onClick={() => setSelectedIdx(q.index)}
                    className="inspector-item"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {agentItem && <span className={`badge ${agentItem.style}`} title={corpusAgentLabel}>
                        <CorpusModeMark mode="agent" labeled />{agentItem.label}
                      </span>}
                      <span className={`badge ${retrieval.style}`} title={needleLabel}>
                        <CorpusModeMark mode="needle" labeled />{retrieval.label}
                      </span>
                    </div>
                    <div className="mt-1.5 text-[13px] font-medium text-(--ui-foreground)">
                      {q.queryText}
                    </div>
                    <div className="mono mt-1 flex items-center justify-between text-[11px] text-(--ui-muted-foreground)">
                      <span className="truncate">{q.provenance.entity ?? q.field}</span>
                      <span>{q.goldValue}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {activeQuestion && (
              <div className="inspector-detail">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-(--ui-border) pb-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="badge badge--neutral">
                        {activeQuestion.field.toUpperCase()}
                      </span>
                      <span className="badge badge--neutral">
                        {bucketLabel(activeQuestion.bucket)}
                      </span>
                      {activeQuestion.provenance.ticker && (
                        <span className="badge badge--neutral">
                          {activeQuestion.provenance.ticker}
                        </span>
                      )}
                    </div>
                    <h3 className="mt-2 text-base font-semibold text-(--ui-foreground)">
                      “{activeQuestion.queryText}”
                    </h3>
                  </div>

                  <div className="text-right">
                    <div className="kpi-label">Expected answer</div>
                    <div className="mono mt-1 text-base font-semibold text-(--corpus-ink)">
                      {activeQuestion.goldValue || "No reference answer"}
                    </div>
                    {activeQuestion.provenance.entity && (
                      <div className="text-xs text-(--ui-muted-foreground)">
                        {activeQuestion.provenance.entity}
                        {activeQuestion.provenance.sourceUrl && (
                          <>
                            {" "}
                            ·{" "}
                            <a
                              href={activeQuestion.provenance.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-(--ui-ring) hover:underline"
                            >
                              {activeQuestion.provenance.registry ?? "source"}
                            </a>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                  <div key={activeQuestion.queryId} className="question-comparison">
                    {(agent || agentRetrieval) && <div>
                      <div className="comparison-heading">
                        <h4 className="report-engine"><CorpusModeMark mode="agent" />{corpusAgentLabel}</h4>
                        <span className={`badge ${agentOutcome.style}`}>{agentOutcome.label}</span>
                      </div>
                      {agentDiscovery && <>
                        <p><code>_/index</code> → <code>{selectedCorpus(agentDiscovery)}</code></p>
                        <details className="trace-detail">
                          <summary>Index queries and corpus searches</summary>
                          <ul>{agentDiscovery.indexQueries.map((query, i) => <li key={i}><code>_/index</code> · {query}</li>)}</ul>
                          <ul>{agentDiscovery.searchQueries?.map(({ corpus, query }, i) => <li key={i}><code>{corpus}</code> · {query}</li>)}</ul>
                          <p>{agentDiscovery.reasoning}</p>
                        </details>
                      </>}
                      {evidenceReady && agentRetrieval && <details className="trace-detail">
                        <summary>Corpus retrieval evidence</summary>
                        <EvidenceList title={corpusAgentLabel} subtitle={activeQuestion.queryText} result={agentRetrieval} k={manifest.k} mode="agent" discovery={agentDiscovery} />
                      </details>}
                    </div>}
                    {!evidenceReady && <p role="status">{evidence?.file === file ? "Evidence could not be loaded." : "Loading evidence…"}</p>}
                    <div>
                      <div className="comparison-heading">
                        <h4 className="report-engine"><CorpusModeMark mode="needle" />{needleLabel}</h4>
                        <span className={`badge ${activeRetrievalOutcome.style}`}>{activeRetrievalOutcome.label}</span>
                      </div>
                      <p><code>_/index</code> → <code>{selectedCorpus(activeQuestion.discovery)}</code></p>
                      <p>{discoveryMissed ? "Skipped search because no relevant corpus was found." : activeQuestion.discovery?.mode === "eve"
                        ? `Original query · Eve-ranked URLs · up to ${manifest.k} results`
                        : `Original query · top ${manifest.k} results`}</p>
                      {activeQuestion.discovery && <details className="trace-detail">
                        <summary>Index queries and routing decision</summary>
                        <ul>{activeQuestion.discovery.indexQueries.map((query, i) => <li key={i}>{query}</li>)}</ul>
                        <p>{activeQuestion.discovery.reasoning}</p>
                      </details>}
                      {evidenceReady && activeRetrieval && <details className="trace-detail">
                        <summary>Corpus retrieval evidence</summary>
                        <EvidenceList title={needleLabel} subtitle={activeQuestion.queryText} result={activeRetrieval} k={manifest.k} mode="needle" discovery={activeQuestion.discovery} />
                      </details>}
                    </div>
                    {provider && <div>
                      <div className="comparison-heading">
                        <h4>{provider.displayName} <span className="font-normal text-(--ui-muted-foreground)">· Published NEEDLE</span></h4>
                        <span className={`badge ${providerOutcome.style}`}>{providerOutcome.label}</span>
                      </div>
                      {evidenceReady && providerResult && <details className="trace-detail">
                        <summary>Published retrieval evidence</summary>
                        <EvidenceList title={provider.displayName} subtitle={activeQuestion.queryText} result={providerResult} k={manifest.k} published={showPublishedGrade} />
                      </details>}
                    </div>}
                  </div>
              </div>
            )}
          </div>
        </section>

        {/* Reproducibility & Archive Downloads */}
        <section id="reproduce">
          <h2 className="section-heading">Appendix · Reproduce &amp; download</h2>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="panel-box p-4">
              <h3 className="text-sm font-semibold">Run artifacts</h3>
              <p className="mt-1 text-xs text-(--ui-muted-foreground)">
                Download the inputs and raw scores for this run.
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <a className="badge badge--neutral hover:text-(--ui-foreground)" href={manifest.files.manifest}>
                  manifest.json
                </a>
                <a className="badge badge--neutral hover:text-(--ui-foreground)" href={manifest.files.inputs}>
                  inputs.json
                </a>
                {needleCompatible && <a
                  className="badge badge--neutral hover:text-(--ui-foreground)"
                  href={manifest.files.needleCompatible}
                >
                  needle-compatible.json
                </a>}
                {manifest.files.agent && <a className="badge badge--neutral hover:text-(--ui-foreground)" href={manifest.files.agent}>agent.json</a>}
                {manifest.files.scoresCsv && <a className="badge badge--neutral hover:text-(--ui-foreground)" href={manifest.files.scoresCsv}>scores.csv</a>}
                <a
                  className="badge badge--ultimate hover:underline"
                  href={manifest.upstreamUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Upstream HF Run ↗
                </a>
                <a
                  className="badge badge--neutral hover:underline"
                  href={manifest.upstreamCodeUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  keenableai/needle ↗
                </a>
              </div>

              <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
                <dt className="text-(--ui-muted-foreground)">Corpus CLI</dt>
                <dd className="mono">{manifest.corpus.cliVersion}</dd>
                <dt className="text-(--ui-muted-foreground)">Index snapshot</dt>
                <dd className="mono break-all">
                  {manifest.corpus.indexRef} ({manifest.corpus.indexSnapshot.id})
                </dd>
                {resolvedCorporaList.map(([slug, snap]) => (
                  <div key={slug} className="contents">
                    <dt className="text-(--ui-muted-foreground)">{slug}</dt>
                    <dd className="mono break-all">
                      {snap.ref} ({snap.id}) · {snap.documents.toLocaleString()} docs
                    </dd>
                  </div>
                ))}
                <dt className="text-(--ui-muted-foreground)">Tracked batches since</dt>
                <dd className="mono">{startDate}</dd>
              </dl>
            </div>

            <div className="panel-box p-4">
              <h3 className="text-sm font-semibold">Reproduce locally</h3>
              <p className="mt-1 text-xs text-(--ui-muted-foreground)">
                Reading from the Corpus Library at <code>{manifest.corpus.registry}</code> is public and
                requires no login. Set <code>AI_GATEWAY_API_KEY</code> (Vercel AI Gateway) to run both modes.
              </p>
              <pre className="code-block mt-3">{reproCommands}</pre>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
