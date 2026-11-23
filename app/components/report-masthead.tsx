import Image from "next/image";
import Link from "next/link";

export function ReportMasthead() {
  return (
    <header className="report-masthead">
      <div className="report-masthead-inner report-column">
        <div className="report-brand">
          <a className="report-wordmark" href="https://runcorpus.com/">
            <Image src="/corpus-wordmark.svg" alt="Corpus" width={59} height={18} unoptimized />
          </a>
          <Link className="report-benchmark-name" href="/">NEEDLE</Link>
        </div>
        <nav aria-label="Benchmark links" className="report-nav">
          <a className="guide-link" href="/results.md" title="Results as Markdown">MD</a>
          <a className="guide-link gap-1" href="https://github.com/runcorpus/needle">
            GitHub <span aria-hidden="true">↗</span>
          </a>
          <a className="guide-link gap-1" href="https://keenableai.github.io/needle/">
            Original NEEDLE <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </div>
    </header>
  );
}
