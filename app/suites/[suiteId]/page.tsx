import { notFound } from "next/navigation";
import { reportCorpusRows } from "@/lib/report-results";
import { loadCorpusWeeklyReport, loadRunBundle, loadViewerRunIndex } from "@/lib/runs";
import publishedReport from "../../../data/needle-report.json";
import { BenchmarkView } from "../../components/benchmark-view";
import { SuiteNav, suites } from "../../components/suite-nav";

export function generateStaticParams() {
  return suites.map(({ id }) => ({ suiteId: id }));
}

export default async function SuitePage({ params }: { params: Promise<{ suiteId: string }> }) {
  const { suiteId } = await params;
  const suite = suites.find(({ id }) => id === suiteId);
  if (!suite) notFound();

  const [{ runs, startDate }, weekly] = await Promise.all([loadViewerRunIndex(), loadCorpusWeeklyReport()]);
  const suiteRuns = runs.filter((run) => run.vertical === suite.id && !run.slice);
  const latest = suiteRuns[0];
  const bundle = latest ? await loadRunBundle(latest.id) : null;
  if (bundle) {
    const leaderboard = publishedReport.leaderboards[suite.id];
    const weeklyLeaderboard = {
      ...leaderboard,
      logos: publishedReport.logos,
      corpusRows: reportCorpusRows(suite.id, leaderboard.columns, [], weekly),
    };
    return <BenchmarkView key={bundle.manifest.id} bundle={bundle} runs={suiteRuns} startDate={startDate} weeklyLeaderboard={weeklyLeaderboard} />;
  }

  return (
    <main className="report-column">
      <SuiteNav current={suite.id} />
      <section className="report-overview">
        <h1 className="report-title">{suite.label}</h1>
        <p>{suite.description} The first full batch hasn’t run yet.</p>
      </section>
    </main>
  );
}
