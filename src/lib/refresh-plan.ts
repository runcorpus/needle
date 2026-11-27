import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchConfig, Ledger, RetrievalHarnessId, VerticalConfig } from "./types";
import type { UpstreamRunDescriptor } from "./upstream";

const configPath = join(process.cwd(), "data", "config.json");
const ledgerPath = join(process.cwd(), "data", "ledger.json");
export const COMPARISON_VERSION = 2;

export async function loadConfig(): Promise<BenchConfig> {
  return JSON.parse(await readFile(configPath, "utf8"));
}

export async function loadLedger(): Promise<Ledger> {
  try {
    return JSON.parse(await readFile(ledgerPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 2, processed: {} };
  }
}

export async function saveLedger(ledger: Ledger) {
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

export function parseHarnessSelection(
  raw: string | undefined,
  defaults: RetrievalHarnessId[],
): RetrievalHarnessId[] {
  if (!raw || raw === "configured" || raw === "all") return [...defaults];
  if (raw === "both") return ["needle-compatible", "agent"];
  const valid: RetrievalHarnessId[] = [];
  for (const id of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    if (id !== "needle-compatible" && id !== "agent") {
      throw new Error(`Unknown harness "${id}". Valid harnesses: needle-compatible, agent, both, configured`);
    }
    if (!valid.includes(id)) valid.push(id);
  }
  return valid;
}

export function dueSuiteRuns(
  suites: VerticalConfig[],
  runs: UpstreamRunDescriptor[],
  ledger: Ledger,
  harnesses: RetrievalHarnessId[],
  upgradePending: boolean,
) {
  return suites.flatMap((suite) => {
    const run = runs.findLast((batch) => batch.vertical === suite.id);
    if (!run) return [];
    const id = `${run.runId}-${run.vertical}`;
    const recorded = ledger.processed[id]?.harnesses;
    const due = harnesses.filter((harness) => {
      const entry = recorded?.[harness];
      return !entry || (upgradePending && (entry.status === "pending_gateway_key" || entry.comparisonVersion !== COMPARISON_VERSION));
    });
    return due.length ? [{ suite, run, harnesses: due }] : [];
  });
}
