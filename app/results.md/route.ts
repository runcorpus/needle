import type { PublishedReport } from "@/lib/published-report";
import { renderResultsMarkdown } from "@/lib/results-markdown";
import { loadCorpusWeeklyReport, loadRunIndex } from "@/lib/runs";
import publishedReport from "../../data/needle-report.json";

export const dynamic = "force-static";

export async function GET() {
  const [{ runs }, weekly] = await Promise.all([loadRunIndex(), loadCorpusWeeklyReport()]);
  return new Response(renderResultsMarkdown(publishedReport as PublishedReport, runs, weekly), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
