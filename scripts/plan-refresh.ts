import { appendFile } from "node:fs/promises";
import { dueSuiteRuns, loadConfig, loadLedger, parseHarnessSelection } from "../src/lib/refresh-plan";
import { describeRun, discoverUpstreamRuns } from "../src/lib/upstream";

const config = await loadConfig();
const { RUN_ID: runId, VERTICAL: vertical, HARNESS: selection, UPGRADE_PENDING: upgradePending, GITHUB_OUTPUT: output } = process.env;
const harnesses = parseHarnessSelection(selection, config.enabledHarnesses);
if (!harnesses.length) throw new Error("Select at least one harness.");

const suites = config.verticals.filter((suite) => suite.enabled && (!vertical || suite.id === vertical));
const upstream = runId
  ? await describeRun(config.upstreamRepo, runId)
  : await discoverUpstreamRuns(config);
const selected = runId
  ? upstream.filter((run) => !vertical || run.vertical === vertical)
    .map((run) => ({ run, harnesses }))
  : dueSuiteRuns(suites, upstream, await loadLedger(), harnesses, upgradePending === "true");

if (runId && !selected.length) throw new Error(`No matching published NEEDLE suite in ${runId}`);
const ready = runId ? selected : (await Promise.all(selected.map(async (entry) => {
  const { run } = entry;
  const archived = await describeRun(config.upstreamRepo, run.runId, { allowMissing: true });
  if (archived.some(({ vertical }) => vertical === run.vertical)) return entry;
  console.log(`Waiting for the ${run.vertical} archive for ${run.runId}.`);
  return null;
}))).filter((entry) => entry !== null);

const matrix = { include: ready.map(({ run, harnesses }) => ({
  vertical: run.vertical,
  run_id: run.runId,
  harness: harnesses.length === 2 ? "both" : harnesses[0],
})) };
console.log(`Planned ${matrix.include.length} suite(s) for ${harnesses.join(", ")}.`);
if (output) {
  const normalizedHarness = harnesses.length === 2 ? "both" : harnesses[0];
  const batch = vertical ? matrix.include[0] : undefined;
  await appendFile(output, [
    `matrix=${JSON.stringify(matrix)}`,
    `has_work=${matrix.include.length > 0}`,
    `requested_harness=${normalizedHarness}`,
    `run_id=${batch?.run_id ?? ""}`,
    `due_harness=${batch?.harness ?? ""}`,
  ].join("\n") + "\n");
}
