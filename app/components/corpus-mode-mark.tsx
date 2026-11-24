import { corpusAgent, corpusNeedle, type CorpusReportMode } from "@/lib/report-results";

export const corpusMarkerPaths = {
  agent: "M-3.3-3.3h6.6v6.6h-6.6Z",
  needle: "M-3.4 0a3.4 3.4 0 1 0 6.8 0a3.4 3.4 0 1 0-6.8 0Z",
} satisfies Record<CorpusReportMode, string>;

export function CorpusModeMark({ mode, labeled = false }: { mode: CorpusReportMode; labeled?: boolean }) {
  const label = mode === "agent" ? corpusAgent : corpusNeedle;
  return (
    <svg className="corpus-mode-mark" viewBox="-5 -5 10 10" role={labeled ? "img" : undefined}
      aria-label={labeled ? label : undefined} aria-hidden={labeled ? undefined : true}>
      <path d={corpusMarkerPaths[mode]} />
    </svg>
  );
}
