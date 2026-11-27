import { parseHarnessSelection } from "../src/harnesses";
import { executeRun } from "../src/lib/runner";
import { loadConfig } from "../src/lib/refresh-plan";
import { describeRun, discoverUpstreamRuns, fetchBatch } from "../src/lib/upstream";

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supported = new Set(["run", "vertical", "slice", "sample", "harness", "no-llm", "dry-run"]);
  const unknown = Object.keys(args).find((key) => !supported.has(key));
  if (unknown) throw new Error(`Unknown option: --${unknown}`);
  const sampleSize = typeof args.sample === "string" ? Number(args.sample) : undefined;
  if (args.sample !== undefined && (!sampleSize || !Number.isSafeInteger(sampleSize) || sampleSize < 1)) {
    throw new Error("--sample requires a positive question count.");
  }
  const config = await loadConfig();
  const runId = typeof args.run === "string" ? args.run : undefined;
  const financeSlice = typeof args.slice === "string" && args.slice !== "all";
  const vertical = typeof args.vertical === "string" ? args.vertical : financeSlice ? "finance" : undefined;
  if (vertical && !config.verticals.some((v) => v.id === vertical)) throw new Error(`Unknown vertical: ${vertical}`);
  const descriptors = runId
    ? await describeRun(config.upstreamRepo, runId)
    : await discoverUpstreamRuns(config);
  const selected = descriptors.filter((run) =>
    (!vertical || run.vertical === vertical) && (runId || config.verticals.some((v) => v.id === run.vertical && v.enabled)));
  const latest = new Map(selected.map((run) => [run.vertical, run]));
  if (!latest.size) throw new Error("No matching published NEEDLE batch.");
  const harnesses = parseHarnessSelection(typeof args.harness === "string" ? args.harness : undefined, config.enabledHarnesses);
  for (const run of latest.values()) {
    const suite = config.verticals.find((v) => v.id === run.vertical)!;
    const slice = args.slice === "all" ? null : typeof args.slice === "string" ? args.slice : suite.slice;
    if (slice && run.vertical !== "finance") throw new Error("--slice is supported for Finance only");
    const batch = await fetchBatch({ upstreamRepo: config.upstreamRepo, runId: run.runId, vertical: suite.id, slice });
    if (!batch.queries.length) throw new Error(`No matching questions in ${suite.id} batch ${run.runId}`);
    const upstream = sampleSize ? {
      ...batch,
      queries: batch.queries.slice(0, sampleSize),
      sourceRows: batch.sourceRows.slice(0, sampleSize),
      perEngine: Object.fromEntries(Object.entries(batch.perEngine).map(([engine, rows]) => [engine, rows.slice(0, sampleSize)])),
      publishedMetrics: {},
    } : batch;
    console.log(`[needle] ${run.runId} ${suite.id}: ${upstream.queries.length} queries${sampleSize ? " (preview)" : ""} · ${harnesses.join(", ")}`);
    if (!args["dry-run"]) {
      await executeRun({ upstream, slice, sampleSize, batchQueryCount: batch.queries.length, harnesses, skipLlm: Boolean(args["no-llm"]), config });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
