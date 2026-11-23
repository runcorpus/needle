import { notFound } from "next/navigation";
import { latestFullRun, loadRunBundle, loadRunIndex } from "@/lib/runs";
import { BenchmarkView } from "../../components/benchmark-view";
import { SuiteNav, suites } from "../../components/suite-nav";

export function generateStaticParams() {
  return suites.map(({ id }) => ({ suiteId: id }));
}

export default async function SuitePage({ params }: { params: Promise<{ suiteId: string }> }) {
  const { suiteId } = await params;
  const suite = suites.find(({ id }) => id === suiteId);
  if (!suite) notFound();

  const { runs, startDate } = await loadRunIndex();
  const suiteRuns = runs.filter((run) => run.vertical === suite.id && !run.slice);
  const latest = latestFullRun(suiteRuns, suite.id)
    ?? suiteRuns.find((run) => run.simulated && !run.sampleSize);
  const bundle = latest ? await loadRunBundle(latest.id) : null;
  if (bundle) return <BenchmarkView key={bundle.manifest.id} bundle={bundle} runs={suiteRuns} startDate={startDate} />;

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
