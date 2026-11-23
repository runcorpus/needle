import { agentHarness, needleCompatibleHarness } from "./needle-compatible";

export { parseHarnessSelection } from "../lib/refresh-plan";
export { agentHarness, needleCompatibleHarness } from "./needle-compatible";
export type { BenchmarkHarness, HarnessContext } from "./types";

export const HARNESS_REGISTRY = {
  "needle-compatible": needleCompatibleHarness,
  agent: agentHarness,
} as const;
