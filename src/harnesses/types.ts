import type { CaseCheckpoints } from "../eve/checkpoints";
import type { CorpusClient } from "../lib/corpus-cli";
import type { BenchConfig, CorpusSnapshotRef, HarnessId } from "../lib/types";
import type { ParsedBatch } from "../lib/upstream";

export interface HarnessContext {
  config: BenchConfig;
  upstream: ParsedBatch;
  outputDir: string;
  corpus: CorpusClient;
  cliVersion: string;
  indexSnapshot: CorpusSnapshotRef;
  skipLlm: boolean;
  caseCheckpoints?: CaseCheckpoints;
  pinnedCorpora?: Record<string, CorpusSnapshotRef>;
}

export interface BenchmarkHarness<TOutput> {
  readonly id: HarnessId;
  readonly label: string;
  readonly description: string;
  readonly artifactFilename: string;
  run(ctx: HarnessContext): Promise<TOutput>;
}
