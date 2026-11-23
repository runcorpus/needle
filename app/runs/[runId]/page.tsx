import { notFound } from "next/navigation";
import { loadRunBundle, loadRunIndex } from "@/lib/runs";
import { BenchmarkView } from "../../components/benchmark-view";

export async function generateStaticParams() {
  const index = await loadRunIndex();
  return index.runs.map((run) => ({ runId: run.id }));
}

export default async function RunArchivePage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const [index, bundle] = await Promise.all([loadRunIndex(), loadRunBundle(runId)]);
  if (!bundle) notFound();
  const runs = index.runs.filter((run) => run.vertical === bundle.manifest.vertical && (!run.slice || run.id === runId));
  return <BenchmarkView key={runId} bundle={bundle} runs={runs} startDate={index.startDate} />;
}
