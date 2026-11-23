import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isLocalRunSlug, LOCAL_RUNS_DIR } from "@/lib/runs";

const jsonFiles = /^(manifest|inputs|needle-compatible|agent|corpusqa-compatible)\.json$|^evidence\/\d+\.json$/;

export async function GET(_request: Request, { params }: { params: Promise<{ parts: string[] }> }) {
  if (process.env.NODE_ENV !== "development") return new Response(null, { status: 404 });
  const [runId, ...segments] = (await params).parts;
  const filename = segments.join("/");
  const isCsv = filename === "scores.csv";
  if (!runId || !isLocalRunSlug(runId) || (!isCsv && !jsonFiles.test(filename))) {
    return new Response(null, { status: 404 });
  }
  const content = await readFile(join(LOCAL_RUNS_DIR, runId, filename), "utf8").catch(() => null);
  if (content === null) return new Response(null, { status: 404 });
  return new Response(content, {
    headers: { "Content-Type": isCsv ? "text/csv; charset=utf-8" : "application/json" },
  });
}
