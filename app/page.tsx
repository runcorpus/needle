import Link from "next/link";
import { type PublishedReport } from "@/lib/published-report";
import { latestFullRunsBySuite, loadCorpusWeeklyReport, loadReportRunLinks, loadRunIndex } from "@/lib/runs";
import publishedReport from "../data/needle-report.json";
import { HomeBenchmarkReport } from "./components/home-benchmark-report";
import { suites } from "./components/suite-nav";
import { LocalTime } from "./components/local-time";

export default async function HomePage() {
  const [{ runs }, weekly] = await Promise.all([loadRunIndex(), loadCorpusWeeklyReport()]);
  const latestRuns = latestFullRunsBySuite(runs);
  const lastFull = latestRuns[0];
  const cliVersion = lastFull?.corpusCliVersion?.trim().replace(/^corpus\s+/i, "").replace(/^(\d)/, "v$1");
  const runLinks = await loadReportRunLinks(latestRuns, null);

  return (
    <div className="report-column">
      <main>
        <section id="overview" className="report-overview">
          <h1 className="report-title report-home-title">Corpus NEEDLE Benchmark</h1>
          <p className="report-run-date">
            <strong>{lastFull ? <>Latest full batch · <LocalTime iso={lastFull.upstreamRunDate} /></> : "Full batches pending"}</strong>
          </p>
          <p>
            This benchmark compares Corpus against live web search APIs on queries from Keenable’s{" "}
            <a href="https://keenableai.github.io/needle/">NEEDLE</a>. For each question, a small{" "}
            <a href="https://eve.dev/">Eve</a> agent running DeepSeek V4.1 Flash checks the Library index{" "}
            (<code>_/index</code>) to pick a relevant corpus and queries it through the Corpus CLI
            {cliVersion ? ` (${cliVersion})` : ""}—a fast-model baseline.
          </p>
          <p>
            <strong>Corpus (NEEDLE)</strong> runs the original query verbatim at the published depth, then ranks the URLs
            it finds. We score that list using NEEDLE’s metrics and compare it with the published provider scores.
          </p>
          <p>
            <strong>Corpus (Agent)</strong> receives the suite’s broad research scope and can rewrite the query before
            searching. It returns the same ranked URL format and uses the same retrieval depth and NEEDLE scoring as
            Corpus (NEEDLE).
          </p>
          <p>
            <small>
              NEEDLE is Keenable’s public benchmark; this mirror exists solely to track Corpus performance and guide
              development priorities.
            </small>
          </p>
        </section>

        <HomeBenchmarkReport report={publishedReport as PublishedReport} runs={runLinks} weekly={weekly} />

        <section id="appendix" className="report-section report-appendix">
          <h2 className="report-section-heading">Appendix</h2>

          <section>
            <h3>How Corpus searches</h3>
            <p>
              Both variants give Eve the original NEEDLE question and start with the Library catalog (<code>_/index</code>)
              attached. Eve uses <code>corpus_list</code> to inspect its attachments, <code>corpus_search</code> to search
              the catalog, and <code>corpus_add</code> to attach a collection before searching its documents. Each question
              has its own attachments and can keep searching within its token budget.
            </p>
            <p>
              <strong>Corpus (NEEDLE)</strong> receives the original question and sends it verbatim to document collections. {" "}
              <strong>Corpus (Agent)</strong> also receives suite-level research context and can rewrite document queries.
              Both variants can freely phrase catalog queries. Paired runs use the same
              model and Library index snapshot, and share the snapshot for any corpus they both search.
            </p>
            <p>
              Both variants return <code>{'{"urls": [...]}'}</code> with up to <var>K</var> distinct retrieved URLs in
              relevance order. The grader receives the original question and the ranked evidence, including titles,
              snippets, and publication dates when available.
            </p>
            <p>
              Both use Eve’s 64,000-token context window, with cumulative limits of 200,000 input and 32,768 output
              tokens per question. Eve allows up to 4,096 output tokens per research call and reserves up to 16,384 for
              the final ranking. When Eve switches to the final ranking, it stops tool calls and returns the ranked
              URLs. It runs up to four questions concurrently, with a five-minute timeout per question.
            </p>
          </section>

          <section>
            <h3>How each suite is scored</h3>
            <p>Both variants use the same pinned upstream NEEDLE evaluator for each suite.</p>
            <p>
              <strong>Finance</strong> checks for answer evidence in the top results, using NEEDLE’s fallback judge when
              the batch enables it. <strong>Scholar</strong> checks for the target paper. <strong>Legal</strong> checks for
              the target case or regulation.
            </p>
            <p>
              <strong>News and AgenticRare</strong> grade ranking quality with nDCG@5. They use the published batch’s judge
              model and query profile and normalize against its <em>Ultimate</em> ranking. Ultimate pools results from
              the original providers. Both variants are compared with the same published provider scores.
            </p>
          </section>

          <section>
            <h3>How seven-day results are calculated</h3>
            <p>
              Corpus averages scored questions from measured full batches in the seven-day window. A suite’s 95% confidence
              interval requires at least two distinct batches and two distinct questions. Overall averages the five suites’
              shares of Ultimate, with zero for suites without results. Its interval requires at least two batches in all five suites.
            </p>
          </section>

          {lastFull ? (
            <section>
              <h3>Latest full runs</h3>
              <ul className="panel-box" role="list">
                {latestRuns.map((run) => (
                  <li key={run.id} className="border-b border-(--ui-border) px-3 py-2 last:border-b-0">
                    <Link className="text-(--corpus-ink) hover:underline" href={`/runs/${run.id}`} prefetch={false}>
                      {suites.find(({ id }) => id === run.vertical)?.label ?? run.vertical}
                    </Link>
                    <span className="ml-3 text-sm text-(--ui-muted-foreground)">
                      <LocalTime iso={run.upstreamRunDate} /> · {run.queryCount} questions
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </section>
      </main>
    </div>
  );
}
