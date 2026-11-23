export const reportTabs = ["overall", "scholar", "news", "finance", "agentic_rare", "legal"] as const;
export type ReportTab = (typeof reportTabs)[number];

export interface Standing {
  engine: string;
  overall: number;
  shares: (number | null)[];
}

export interface PublishedReport {
  sourceUpdated: string;
  standings: Standing[];
  gap: { overall: number; shares: number[] };
  leaderboards: Record<ReportTab, { caption: string; columns: string[]; rows: string[][] }>;
  latency: { engine: string; p50: number; p95: number; p50Label: string; p95Label: string }[];
  logos: Record<string, string>;
}
