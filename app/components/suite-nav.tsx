import Link from "next/link";
import type { VerticalId } from "@/lib/types";

export const suites: ReadonlyArray<{ id: VerticalId; label: string; description: string }> = [
  { id: "finance", label: "Finance", description: "Company facts and SEC filings." },
  { id: "scholar", label: "Scholar", description: "Papers identified from partial titles, clues, or details from the text." },
  { id: "legal", label: "Legal", description: "Federal court opinions and sections of the U.S. Code of Federal Regulations." },
  { id: "news", label: "News", description: "Current stories from fresh search queries." },
  { id: "agentic_rare", label: "AgenticRare", description: "Obscure entities from agent search logs." },
];

export function SuiteNav({ current }: { current?: VerticalId }) {
  return (
    <nav className="suite-nav report-column" aria-label="Benchmark suites">
      <Link className="guide-link" href="/" aria-current={current ? undefined : "page"}>
        All suites
      </Link>
      {suites.map(({ id, label }) => (
        <Link
          key={id}
          className="guide-link"
          href={`/suites/${id}`}
          prefetch={false}
          aria-current={current === id ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
