"use client";

import { Input } from "@ui-sdk/react/input";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type {
  RunBundle,
  RunIndexEntry,
  NeedleCompatibleProviderSummary,
  ProviderQueryResult,
  RankedEvidence,
  DiscoveryOutcome,
} from "@/lib/types";
import { SuiteNav, suites } from "./suite-nav";

const corpusAgentLabel = "Corpus (Agent)";
const needleLabel = "Corpus (NEEDLE)";

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
          <div className="text-xs text-[#a6a6a6]">
            {relevance ? `${summary.scored} scored` : `${summary.hits}/${summary.scored} hits`}
          </div>
        </>
      ) : <span className="text-xs text-[#a6a6a6]">{summary ? "Unscored" : "Pending"}</span>}
    </td>
  );
}

function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d) + " UTC"
  );
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

function bucketLabel(bucket: string): string {
  if (bucket === "finance") return "Keyword";
  if (bucket === "finance_nl") return "Natural language";
  if (bucket === "filings") return "SEC filings";
  if (bucket === "filingdoc") return "SEC document";
  return bucket;
}

function retrievalOutcome(result: ProviderQueryResult | null | undefined, k: number, useHitRank = true) {
  if (!result) return { label: "Not run", style: "badge--neutral" };
  if (result.unscoredReason) return { label: "Unscored", style: "badge--neutral" };
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
  isCorpus,
  published,
}: {
  title: string;
  subtitle: string;
  result: ProviderQueryResult | null | undefined;
  k: number;
  isCorpus?: boolean;
  published?: boolean;
}) {
  const { label, style } = retrievalOutcome(result, k, published);
  const results = result?.results ?? [];
  const error = result?.unscoredReason ?? result?.searchError;
  return (
    <div className="panel-box">
      <div className="panel-header">
        <div>
          <h3 className={isCorpus ? "text-[#5ee69c]" : ""}>{title}</h3>
          <div className="text-[11px] text-[#a6a6a6]">{subtitle}</div>
        </div>
        <span className={`badge ${style}`}>{label}</span>
      </div>

      <div className="space-y-2 p-3">
        {error && (
          <div className="border border-[#e05d4d]/40 bg-[#e05d4d]/10 px-3 py-2 text-xs text-[#ff9588]">
            {typeof error === "string" ? error : JSON.stringify(error)}
          </div>
        )}
        {results.length === 0 && !error && (
          <div className="py-4 text-center text-xs text-[#a6a6a6]">{result ? "No results returned." : "No saved result for this question."}</div>
        )}
        {results.map((item) => (
          <div
            key={`${item.rank}-${item.url}`}
            className={`evidence-card ${item.detMatch ? "evidence-card--hit" : ""}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="mono text-xs text-[#a6a6a6]">#{item.rank}</span>
                {item.rating !== undefined ? (
                  <span className="badge badge--neutral">{item.rating == null ? "Unrated" : `Relevance ${item.rating}/4`}</span>
                ) : item.detMatch ? (
                  <span className="badge badge--hit">{item.matchedIn === "none" ? "Identity match" : `Hit · ${item.matchedIn}`}</span>
                ) : item.judgeMatch === true ? (
                  <span className="badge badge--warn">Upstream judge hit</span>
                ) : (
                  <span className="badge badge--neutral">Miss</span>
                )}
              </div>
              {typeof item.score === "number" && (
                <span className="mono text-[11px] text-[#a6a6a6]">
                  score {item.score.toFixed(2)}
                </span>
              )}
            </div>

            <div className="mt-1.5 font-medium text-[#fafafa] break-words">
              {item.title || "(untitled)"}
            </div>

            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="mono mt-0.5 block truncate text-[11px] text-[#a1bfff] hover:underline"
              >
                {item.url}
              </a>
            )}

            {item.snippet && (
              <p className="mt-1.5 line-clamp-4 text-xs text-[#b5b5b5] whitespace-pre-wrap break-words">
                {item.snippet}
              </p>
            )}

            {item.meta && typeof item.meta.lei === "string" && (
              <div className="mono mt-1.5 text-[11px] text-[#a6a6a6]">
                meta.lei: <span className="text-[#fafafa]">{item.meta.lei}</span>
                {typeof item.meta.country === "string" ? ` · ${item.meta.country}` : ""}
                {typeof item.meta.entity_status === "string" ? ` · ${item.meta.entity_status}` : ""}
              </div>
            )}

            <div className="mt-2 border-t border-[#262626] pt-1.5 text-[11px] text-[#a6a6a6]">
              {item.matchReason}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BenchmarkView({ bundle, runs, startDate }: { bundle: RunBundle; runs: RunIndexEntry[]; startDate: string }) {
  const router = useRouter();
  const { manifest, needleCompatible, agent, questions } = bundle;
  const [showAllProviders, setShowAllProviders] = useState(false);

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
  const agentOutcome = retrievalOutcome(agentRetrieval, manifest.k);
  const providerResult = provider && withEvidence(activeQuestion?.providersNeedle[provider.engine]);
  const showPublishedGrade = !manifest.slice || (needleCompatible ?? agent)?.grading === "needle";
  const providerOutcome = retrievalOutcome(providerResult, manifest.k, showPublishedGrade);
  const discoveryMissed = activeQuestion?.discovery?.status === "not_found";
  const activeRetrievalOutcome = discoveryMissed
    ? { label: "No relevant corpus", style: "badge--miss" }
    : retrievalOutcome(activeRetrieval, manifest.k);

  const relevance = manifest.vertical === "news" || manifest.vertical === "agentic_rare";
  const retrievalMetric = relevance ? `nDCG@${manifest.k}` : `Recall@${manifest.k}`;
  const displayedProviders = showAllProviders ? comparableProviders : comparableProviders.slice(0, 5);
  const ultimate = needleProviders.find((p) => p.isUltimate);
  const retrievalRows = [
    { id: "corpus-agent", name: corpusAgentLabel, summary: corpusAgent },
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
  const batchLabel = manifest.simulated ? "Simulated" : manifest.sampleSize ? "Preview" : manifest.slice ? `${manifest.slice.toUpperCase()} slice` : "Full batch";
  const questionLabel = manifest.queryCount === 1 ? "question" : "questions";
  const selectableRuns = runs.filter((run) => !run.sampleSize);
  const selectedRun = selectableRuns.find((run) => run.id === manifest.id)?.id ?? "";

  const harness = agent ? (needleCompatible ? "both" : "agent") : "needle-compatible";
  const runCommand = `bun run bench:run --run ${manifest.upstreamRunId} --vertical ${manifest.vertical} --harness ${harness}${manifest.slice ? ` --slice ${manifest.slice}` : " --slice all"}${manifest.sampleSize ? ` --sample ${manifest.sampleSize}` : ""}`;
  const recordedVersion = manifest.corpus.cliVersion.trim().replace(/^corpus\s+/i, "");
  const releaseVersion = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(recordedVersion)
    ? recordedVersion
    : null;
  const reproCommands = manifest.simulated ? `${runCommand} --simulate-misses` : [
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
          {selectableRuns.length > 0 ? (
            <>
              <label className="sr-only" htmlFor="run-selector">Select benchmark run</label>
              <select
                id="run-selector"
                className="native-select"
                value={selectedRun}
                onChange={(e) => router.push(`/runs/${e.target.value}`)}
              >
                {selectedRun ? null : <option value="" disabled>Choose a run</option>}
                {selectableRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.upstreamRunId} · {r.simulated ? "Simulated" : r.slice ? `${r.slice.toUpperCase()} slice` : "Full batch"} ({r.queryCount}q)
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
            <a href={manifest.upstreamUrl} target="_blank" rel="noreferrer" className="text-[#a1bfff] hover:underline">
              Published NEEDLE batch ↗
            </a>{" "}· {fmtUtc(manifest.upstreamRunDate)}
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
          {manifest.simulated && (
            <p>
              <strong>Simulated Corpus run.</strong> Corpus results here assume discovery missed every question while a
              full run is pending; provider rows are real scores from the NEEDLE batch.
            </p>
          )}
        </section>

        <section id="leaderboard" className="report-section report-column">
          <h2 className="report-section-heading">Quality results</h2>
          {manifest.vertical === "finance" && !manifest.slice && !manifest.simulated && !agent && needleCompatible?.discoveryMode !== "eve" && comparableProviders.some((p) => p.judgeUpgrades > 0) && (
            <p className="mb-3 text-sm text-[#a6a6a6]">
              Corpus Finance recall is scored with NEEDLE’s exact matcher only, whereas this batch’s provider scores
              also include LLM-judged matches.
            </p>
          )}
          <div className="panel-box overflow-x-auto">
            <table className="data-table results-table">
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col" className="num">{retrievalMetric}</th>
                </tr>
              </thead>
              <tbody>
                {retrievalRows.map(({ id, name, summary }) => {
                  const isCorpus = id === "corpus" || id === "corpus-agent";
                  return (
                    <tr key={id} className={summary?.isUltimate ? "row--ultimate" : isCorpus ? "row--corpus" : undefined}>
                      <th scope="row" className={isCorpus ? "result--corpus" : undefined}>{name}</th>
                      <RetrievalScore summary={summary} relevance={relevance} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {comparableProviders.length > 5 && <button
              type="button"
              aria-expanded={showAllProviders}
              className="w-full cursor-pointer border-t border-[#2a2a2a] px-4 py-2 text-left text-xs text-[#a1bfff] hover:underline"
              onClick={() => setShowAllProviders((v) => !v)}
            >
              {showAllProviders ? "Show fewer providers" : `Show all ${comparableProviders.length} published providers`}
            </button>}
          </div>
          {needleCompatible && !relevance && <details className="trace-detail mt-3">
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
                      <th>Tested (UTC)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {needleProviders.map((p) => {
                      const rankIdx = needleProviders
                        .filter((x) => !x.isUltimate)
                        .findIndex((x) => x.engine === p.engine);
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
                          <td className="mono text-[#a6a6a6]">
                            {p.isUltimate ? "★" : rankIdx + 1}
                          </td>
                          <td className="font-medium">
                            <span
                              className={
                                p.isCorpus
                                  ? "text-[#5ee69c]"
                                  : p.isUltimate
                                    ? "text-[#a1bfff]"
                                    : ""
                              }
                            >
                              {p.isCorpus ? needleLabel : p.displayName}
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
                          <td className="num text-[#a6a6a6]">{pct(p.pctOfUltimate)}</td>
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
                          <td className="num text-[#a6a6a6]">
                            {p.serviceErrors + p.accountErrors > 0
                              ? `${p.serviceErrors}s/${p.accountErrors}a`
                              : "0"}
                          </td>
                          <td className="mono text-xs text-[#a6a6a6]">{shortDate(p.testedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
            </div>
          </details>}
        </section>

        {/* Question & Evidence Inspector */}
        <section id="questions">
          <h2 className="section-heading">Compare by question</h2>

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
              aria-label="Filter by query style"
            >
              <option value="all">All styles ({questions.length})</option>
              {buckets.map((b) => (
                <option key={b} value={b}>
                  {bucketLabel(b)}
                </option>
              ))}
            </select>

            {comparableProviders.length > 0 && (
              <div className="ml-auto flex items-center gap-2 text-xs text-[#a6a6a6]">
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
                <div className="p-4 text-xs text-[#a6a6a6]">No matching questions.</div>
              )}
              {filteredQuestions.map((q) => {
                const active = activeQuestion?.index === q.index;
                const retrieval = retrievalOutcome(q.corpusNeedle, manifest.k);
                const agent = q.corpusAgent && retrievalOutcome(q.corpusAgent, manifest.k);
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
                    <div className="flex items-center justify-between gap-2">
                      {agent && <span className={`badge ${agent.style}`}>Agent · {agent.label}</span>}
                      <span className={`badge ${retrieval.style}`}>{retrieval.label}</span>
                    </div>
                    <div className="mt-1.5 text-[13px] font-medium text-[#fafafa]">
                      {q.queryText}
                    </div>
                    <div className="mono mt-1 flex items-center justify-between text-[11px] text-[#a6a6a6]">
                      <span className="truncate">{q.provenance.entity ?? q.field}</span>
                      <span>{q.goldValue}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {activeQuestion && (
              <div className="inspector-detail">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#2a2a2a] pb-3">
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
                    <h3 className="mt-2 text-base font-semibold text-[#fafafa]">
                      “{activeQuestion.queryText}”
                    </h3>
                  </div>

                  <div className="text-right">
                    <div className="kpi-label">Expected answer</div>
                    <div className="mono mt-1 text-base font-semibold text-[#5ee69c]">
                      {activeQuestion.goldValue || "No reference answer"}
                    </div>
                    {activeQuestion.provenance.entity && (
                      <div className="text-xs text-[#a6a6a6]">
                        {activeQuestion.provenance.entity}
                        {activeQuestion.provenance.sourceUrl && (
                          <>
                            {" "}
                            ·{" "}
                            <a
                              href={activeQuestion.provenance.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[#a1bfff] hover:underline"
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
                    <div>
                      <div className="comparison-heading">
                        <h4>{corpusAgentLabel}</h4>
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
                        <EvidenceList title={corpusAgentLabel} subtitle={activeQuestion.queryText} result={agentRetrieval} k={manifest.k} isCorpus />
                      </details>}
                    </div>
                    {!evidenceReady && <p role="status">{evidence?.file === file ? "Evidence could not be loaded." : "Loading evidence…"}</p>}
                    <div>
                      <div className="comparison-heading">
                        <h4>{needleLabel}</h4>
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
                        <EvidenceList title="Corpus" subtitle={activeQuestion.queryText} result={activeRetrieval} k={manifest.k} isCorpus />
                      </details>}
                    </div>
                    {provider && <div>
                      <div className="comparison-heading">
                        <h4>{provider.displayName} <span className="font-normal text-[#a6a6a6]">· Published NEEDLE</span></h4>
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
              <h3 className="text-sm font-semibold">{manifest.simulated ? "Simulation artifacts" : "Run artifacts"}</h3>
              <p className="mt-1 text-xs text-[#a6a6a6]">
                Download the inputs and raw scores for this run.
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <a className="badge badge--neutral hover:text-[#fafafa]" href={manifest.files.manifest}>
                  manifest.json
                </a>
                <a className="badge badge--neutral hover:text-[#fafafa]" href={manifest.files.inputs}>
                  inputs.json
                </a>
                {needleCompatible && <a
                  className="badge badge--neutral hover:text-[#fafafa]"
                  href={manifest.files.needleCompatible}
                >
                  needle-compatible.json
                </a>}
                {manifest.files.agent && <a className="badge badge--neutral hover:text-[#fafafa]" href={manifest.files.agent}>agent.json</a>}
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
                <dt className="text-[#a6a6a6]">Corpus CLI</dt>
                <dd className="mono">{manifest.corpus.cliVersion}</dd>
                <dt className="text-[#a6a6a6]">{manifest.simulated ? "Reference index snapshot" : "Index snapshot"}</dt>
                <dd className="mono break-all">
                  {manifest.corpus.indexRef} ({manifest.corpus.indexSnapshot.id})
                </dd>
                {resolvedCorporaList.map(([slug, snap]) => (
                  <div key={slug} className="contents">
                    <dt className="text-[#a6a6a6]">{slug}</dt>
                    <dd className="mono break-all">
                      {snap.ref} ({snap.id}) · {snap.documents.toLocaleString()} docs
                    </dd>
                  </div>
                ))}
                <dt className="text-[#a6a6a6]">Watermark start</dt>
                <dd className="mono">{startDate}</dd>
              </dl>
            </div>

            <div className="panel-box p-4">
              <h3 className="text-sm font-semibold">Reproduce locally</h3>
              {manifest.simulated ? <p className="mt-1 text-xs text-[#a6a6a6]">Regenerate this local simulation from the upstream NEEDLE batch.</p> : <p className="mt-1 text-xs text-[#a6a6a6]">
                Reading from the Corpus Library at <code>{manifest.corpus.registry}</code> is public and
                requires no login. Set <code>AI_GATEWAY_API_KEY</code> (Vercel AI Gateway) to run both modes.
              </p>}
              <pre className="code-block mt-3">{reproCommands}</pre>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
