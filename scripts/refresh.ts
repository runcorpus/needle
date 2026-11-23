import { hasGatewayApiKey } from "../src/lib/gateway";
import { dueSuiteRuns, loadConfig, loadLedger, parseHarnessSelection } from "../src/lib/refresh-plan";
import { executeRun } from "../src/lib/runner";
import { describeRun, discoverUpstreamRuns, fetchBatch, relevanceSuite } from "../src/lib/upstream";

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
  const upgradePending = Boolean(args["upgrade-pending"]);
  const dryRun = Boolean(args["dry-run"]);

  const config = await loadConfig();
  const ledger = await loadLedger();
  const gatewayReady = hasGatewayApiKey();
  const harnessArg = typeof args.harness === "string" ? args.harness : undefined;
  const targetHarnesses = parseHarnessSelection(harnessArg, config.enabledHarnesses);

  const requested = args.vertical;
  const enabledVerticals = config.verticals.filter((v) => v.enabled && (!requested || requested === v.id));
  if (!enabledVerticals.length) throw new Error("No matching enabled vertical");

  console.log(
    `[refresh] Checking ${config.upstreamRepo} for runs >= ${config.startDate} (enabled: ${enabledVerticals.map((v) => v.id).join(", ")}; harnesses: ${targetHarnesses.join(", ")}; gateway=${gatewayReady})`,
  );

  const runId = typeof args.run === "string" ? args.run : undefined;
  const upstreamRuns = runId ? await describeRun(config.upstreamRepo, runId) : await discoverUpstreamRuns(config);
  const dueRuns = dueSuiteRuns(enabledVerticals, upstreamRuns, ledger, targetHarnesses, upgradePending && gatewayReady);
  const maxRunsPerWake = Number(process.env.MAX_RUNS_PER_WAKE ?? enabledVerticals.length);
  if (!Number.isSafeInteger(maxRunsPerWake) || maxRunsPerWake < 1) throw new Error("MAX_RUNS_PER_WAKE must be a positive integer");
  let executed = 0;
  for (const { suite, run, harnesses } of dueRuns) {
    if (executed >= maxRunsPerWake) break;
    const runSlug = [run.runId, run.vertical, suite.slice].filter(Boolean).join("-");
    if (!dryRun && relevanceSuite(run.vertical) && !gatewayReady) {
      console.log(`[refresh] Deferring ${runSlug} until AI_GATEWAY_API_KEY is configured.`);
      continue;
    }
    const upstream = await fetchBatch({ upstreamRepo: config.upstreamRepo, runId: run.runId, vertical: run.vertical, slice: suite.slice });
    if (upstream.queries.length < suite.minQueries) continue;
    console.log(`[refresh] ${dryRun ? "[dry-run] " : ""}${runSlug}: ${upstream.queries.length} queries · ${harnesses.join(", ")}`);
    if (!dryRun) await executeRun({ upstream, slice: suite.slice, harnesses, config });
    executed++;
  }

  console.log(`[refresh] ${dryRun ? "Planned" : "Executed"} ${executed} batch(es).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
