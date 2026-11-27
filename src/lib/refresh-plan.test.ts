import { expect, test } from "bun:test";
import { COMPARISON_VERSION, dueSuiteRuns } from "./refresh-plan";
import type { HarnessLedgerRecord, Ledger, VerticalConfig } from "./types";
import type { UpstreamRunDescriptor } from "./upstream";

test("refresh schedules only outstanding modes on the latest published batch", () => {
  const suite: VerticalConfig = { id: "scholar", enabled: true, minQueries: 1, description: "" };
  function published(runId: string): UpstreamRunDescriptor {
    return { runId, vertical: "scholar", files: [], runDateIso: "", upstreamUrl: "" };
  }
  const oldest = published("2026-11-23T1014Z");
  const latest = published("2026-11-24T1014Z");
  const completed: HarnessLedgerRecord = {
    status: "completed",
    executedAt: "",
    artifactFile: "needle-compatible.json",
    corpusVersion: "corpus 0.5.0",
    corpusIndexSha256: "",
    comparisonVersion: COMPARISON_VERSION,
  };
  const ledger: Ledger = {
    version: 2,
    processed: {
      [`${latest.runId}-scholar`]: {
        runId: latest.runId,
        vertical: latest.vertical,
        slice: null,
        outputDir: "",
        harnesses: { "needle-compatible": completed },
      },
    },
  };

  expect(dueSuiteRuns([suite], [oldest, latest], ledger, ["needle-compatible", "agent"], false)).toEqual([
    { suite, run: latest, harnesses: ["agent"] },
  ]);
  expect(dueSuiteRuns([suite], [oldest, latest], ledger, ["needle-compatible"], false)).toEqual([]);
});
