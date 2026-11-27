import type { DiscoveryOutcome, RunBundle } from "@/lib/types";
import { corpusAgent, corpusNeedle } from "@/lib/report-results";

const pricedModel = "deepseek/deepseek-v4.1-flash-1017";
const priceSource = "https://vercel.com/ai-gateway/models/" + pricedModel;
const number = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4,
});

// Fixed reference pricing keeps archived runs comparable when gateway rates change.
const deepSeekPerMillion = { input: 0.15, cacheRead: 0.003, output: 0.60 };

function summarize(outcomes: (Pick<DiscoveryOutcome, "model" | "usage"> | null | undefined)[]) {
  let input = 0;
  let output = 0;
  let cacheReads = 0;
  let cacheMetered = 0;
  let reportedCost = 0;
  let costMetered = 0;
  let metered = 0;
  let priced = true;
  for (const outcome of outcomes) {
    const usage = outcome?.usage;
    if (usage?.inputTokens == null || usage.outputTokens == null) continue;
    input += usage.inputTokens;
    output += usage.outputTokens;
    metered++;
    if (usage.cacheReadTokens != null) {
      cacheReads += usage.cacheReadTokens;
      cacheMetered++;
    }
    if (usage.costUsd != null) {
      reportedCost += usage.costUsd;
      costMetered++;
    }
    if (outcome?.model !== pricedModel) priced = false;
  }
  const usd = priced && metered
    ? ((input - cacheReads) * deepSeekPerMillion.input + cacheReads * deepSeekPerMillion.cacheRead + output * deepSeekPerMillion.output) / 1_000_000
    : null;
  return { input, output, metered, usd,
    cacheReads: cacheMetered === metered ? cacheReads : null,
    reportedCost: costMetered === metered ? reportedCost : null,
  };
}

export function RetrievalTokenCost({ questions, localUsage, isLocal }: Pick<RunBundle, "questions" | "localUsage"> & { isLocal: boolean }) {
  const usage = localUsage ?? {
    agent: questions.map(q => q.agentDiscovery),
    "needle-compatible": questions.map(q => q.discovery),
  };
  const rows = [
    { name: corpusAgent, ...summarize(usage.agent ?? []) },
    { name: corpusNeedle, ...summarize(usage["needle-compatible"] ?? []) },
  ];
  if (!rows.some(row => row.metered)) return null;
  return (
    <section id="token-cost" className="report-section report-column">
      <h2 className="report-section-heading">Retrieval token usage and cost</h2>
      <div className="panel-box overflow-x-auto">
        <table className="data-table">
          <thead><tr>
            <th scope="col">Engine</th>
            <th scope="col" className="num">Metered questions</th>
            <th scope="col" className="num">Input tokens</th>
            <th scope="col" className="num">Cache-read tokens</th>
            <th scope="col" className="num">Output tokens</th>
            <th scope="col" className="num">Reported USD</th>
            <th scope="col" className="num">Est. USD</th>
            <th scope="col" className="num">Est. USD/question</th>
          </tr></thead>
          <tbody>{rows.filter(row => row.metered).map(({ name, metered, input, cacheReads, output, reportedCost, usd }) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td className="num">{metered}/{questions.length}</td>
              <td className="num">{number.format(input)}</td>
              <td className="num">{cacheReads === null ? "—" : number.format(cacheReads)}</td>
              <td className="num">{number.format(output)}</td>
              <td className="num">{reportedCost === null ? "—" : dollars.format(reportedCost)}</td>
              <td className="num">{usd === null ? "—" : dollars.format(usd)}</td>
              <td className="num">{usd === null ? "—" : dollars.format(usd / metered)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {rows.some(row => row.usd !== null) && <p className="report-source-date mt-3">
        Costs cover metered retrieval questions from the {isLocal || localUsage ? "local run" : "published run"} and exclude judging. DeepSeek estimates use
        ${deepSeekPerMillion.input.toFixed(2)} per million uncached input tokens, ${deepSeekPerMillion.cacheRead} per
        million cache-read tokens and ${deepSeekPerMillion.output.toFixed(2)} per million output tokens.
        Questions without cache counts use the uncached input rate.{" "}
        <a href={priceSource}>DeepSeek provider rates on AI Gateway, Nov 27, 2026</a>
      </p>}
    </section>
  );
}
