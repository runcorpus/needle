export type VerticalId = "finance" | "scholar" | "legal" | "news" | "agentic_rare";
export type RetrievalHarnessId = "needle-compatible" | "agent";
export type HarnessId = RetrievalHarnessId;

export interface VerticalConfig {
  id: VerticalId;
  enabled: boolean;
  slice: string | null;
  minQueries: number;
  description: string;
}

export interface BenchConfig {
  startDate: string;
  upstreamRepo: string;
  upstreamCodeRepo: string;
  corpusIndex: string;
  corpusRegistry: string;
  searchK: number;
  snippetChars: number;
  enabledHarnesses: RetrievalHarnessId[];
  models: {
    agent: string;
    zeroDataRetention: boolean;
  };
  verticals: VerticalConfig[];
}

export interface HarnessLedgerRecord {
  status: "completed" | "pending_gateway_key";
  executedAt: string;
  artifactFile: string;
  corpusVersion: string;
  corpusIndexSha256: string;
  comparisonVersion?: 1 | 2;
}

export interface LedgerEntry {
  runId: string;
  vertical: VerticalId;
  slice: string | null;
  outputDir: string;
  harnesses: Partial<Record<string, HarnessLedgerRecord>>;
}

export interface Ledger {
  version: number;
  processed: Record<string, LedgerEntry>;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface CorpusSnapshotRef {
  ref: string;
  tag: string | null;
  id: string;
  uri: string | null;
  documents: number;
  labels: Record<string, string>;
}

export interface CorpusSearchHit {
  urn: string;
  url: string;
  score: number;
  meta: {
    title: string;
    description: string;
    [key: string]: unknown;
  };
}

export interface DiscoveryIndexHit {
  corpus: string;
  title: string;
  description: string;
  score: number;
}

export interface DiscoveryOutcome {
  status: "found" | "not_found" | "error";
  mode: "eve" | "llm-gateway" | "index-lexical" | "simulated";
  model: string | null;
  indexQueries: string[];
  indexHits: DiscoveryIndexHit[];
  selectedCorpus: string | null;
  searchedCorpora?: string[];
  searchQueries?: Array<{ corpus: string; query: string }>;
  resolvedTag: string | null;
  resolvedSnapshotId: string | null;
  reasoning: string;
  usage: TokenUsage | null;
}

export interface RankedEvidence {
  rank: number;
  url: string;
  title: string;
  snippet: string;
  score?: number;
  meta?: Record<string, unknown>;
  rating?: number | null;
  detMatch: boolean;
  judgeMatch: boolean | null;
  matchedIn: "url" | "title" | "snippet" | "none";
  matchReason: string;
}

export interface BucketMetrics {
  recall: number;
  mrr: number;
  hits: number;
  scored: number;
  total: number;
}

export interface NeedleCompatibleProviderSummary {
  engine: string;
  displayName: string;
  isCorpus: boolean;
  isUltimate: boolean;
  meanNdcg?: number | null;
  recallAtK: number | null;
  mrrAtK: number | null;
  pctOfUltimate: number | null;
  hits: number | null;
  scored: number;
  total: number;
  serviceErrors: number;
  accountErrors: number;
  judgeUpgrades: number;
  testedAt: string | null;
  byBucket: Record<string, BucketMetrics>;
  discoveryHits?: number;
  discoveryTotal?: number;
  inCorpusRecallAtK?: number | null;
}

export interface ProviderQueryResult {
  timing?: { agentMs: number; searchMs: number[] };
  unscoredReason?: string;
  ndcg?: number | null;
  engine: string;
  hitRank: number | null;
  detRank: number | null;
  searchError: string | null;
  queriedAt: string | null;
  results: RankedEvidence[];
}

export interface QueryProvenance {
  entity: string | null;
  ticker: string | null;
  cik: string | number | null;
  qid: string | null;
  registry: string | null;
  sourceUrl: string | null;
}

export interface BenchmarkInputQuery {
  index: number;
  queryId: string;
  queryText: string;
  field: string;
  fieldType: string;
  bucket: string;
  syntax: string;
  tier: string;
  freshnessWindow: string;
  goldValue: string;
  goldAliases: string[];
  provenance: QueryProvenance;
}

export interface RunInputsArtifact {
  upstreamRunId: string;
  upstreamUrl: string;
  upstreamRunDate: string;
  vertical: VerticalId;
  slice: string | null;
  queries: BenchmarkInputQuery[];
}

export interface NeedleCompatibleQuestionResult {
  queryId: string;
  index: number;
  discovery: DiscoveryOutcome;
  corpusNeedle: ProviderQueryResult;
  evidenceFile?: string;
  providersNeedle: Record<string, ProviderQueryResult>;
}

export interface DiagnosticCheck {
  title: string;
  description: string;
  goldValue: string;
  corpusRef: string;
  queries: Array<{
    label: string;
    queryText: string;
    hitRank: number | null;
    results: RankedEvidence[];
  }>;
}

export interface NeedleCompatibleArtifact {
  harness: RetrievalHarnessId;
  status: "completed";
  executedAt: string;
  method: string;
  k: number;
  snippetChars: number;
  discoveryMode: DiscoveryOutcome["mode"];
  discoveryModel: string | null;
  grading?: "needle";
  corpusCliVersion: string;
  indexSnapshot: CorpusSnapshotRef;
  resolvedCorpora: Record<string, CorpusSnapshotRef>;
  ultimateRecallAtK: number | null;
  ultimateMrrAtK: number | null;
  providers: NeedleCompatibleProviderSummary[];
  questions: NeedleCompatibleQuestionResult[];
  diagnostics: DiagnosticCheck[];
}

export interface QuestionComparison extends BenchmarkInputQuery {
  discovery: DiscoveryOutcome | null;
  corpusNeedle: ProviderQueryResult | null;
  corpusAgent?: ProviderQueryResult;
  agentDiscovery?: DiscoveryOutcome;
  evidenceFile?: string;
  providersNeedle: Record<string, ProviderQueryResult>;
}

interface RetrievalManifest {
  status: "completed" | "not_run";
  executedAt: string | null;
  discoveryMode: DiscoveryOutcome["mode"] | null;
  discoveryModel: string | null;
  primaryMetric: string;
  secondaryMetric: string;
  artifact: string;
}

export interface RunManifest {
  id: string;
  upstreamRunId: string;
  upstreamUrl: string;
  upstreamCodeUrl: string;
  upstreamRunDate: string;
  corpusRunDate: string;
  vertical: VerticalId;
  slice: string | null;
  sampleSize?: number;
  simulated?: true;
  queryCount: number;
  k: number;
  snippetChars: number;
  corpus: {
    cliVersion: string;
    registry: string;
    indexRef: string;
    indexSnapshot: CorpusSnapshotRef;
    resolvedCorpora: Record<string, CorpusSnapshotRef>;
  };
  harnesses: {
    "needle-compatible": RetrievalManifest;
    agent?: RetrievalManifest;
  };
  files: {
    manifest: string;
    inputs: string;
    needleCompatible: string;
    agent?: string;
    scoresCsv: string;
  };
}

export interface RunBundle {
  manifest: RunManifest;
  needleCompatible: Omit<NeedleCompatibleArtifact, "questions"> | null;
  agent: Omit<NeedleCompatibleArtifact, "questions"> | null;
  questions: QuestionComparison[];
  diagnostics: DiagnosticCheck[];
}

export interface RunIndexEntry {
  id: string;
  upstreamRunId: string;
  vertical: VerticalId;
  slice: string | null;
  sampleSize?: number;
  simulated?: true;
  queryCount: number;
  upstreamRunDate: string;
  corpusRunDate: string;
  corpusCliVersion: string;
  corpusNeedleMeanNdcg?: number | null;
  corpusNeedleRecallAtK: number | null;
  corpusNeedleMrrAtK: number | null;
  corpusAgentMeanNdcg?: number | null;
  corpusAgentRecallAtK?: number | null;
  ultimateRecallAtK: number | null;
  discoveryRate: number | null;
  manifestPath: string;
  needleCompatiblePath: string;
  agentPath?: string;
}

export interface RunIndex {
  updatedAt: string;
  startDate: string;
  runs: RunIndexEntry[];
}
