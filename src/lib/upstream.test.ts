import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { describeRun, fetchBatch } from "./upstream";

const runId = "2026-11-22T1200Z";
const upstreamRepo = "fixture/results";
const base = { upstreamRepo, runId };

function serve(files: Record<string, unknown>) {
  const read = async (url: RequestInfo | URL) => {
    const file = files[String(url).split(runId + "/").pop()!];
    if (file === undefined) return new Response(null, { status: 404 });
    return new Response(typeof file === "string" ? file : JSON.stringify(file));
  };
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(read, { preconnect: fetch.preconnect }));
}

afterEach(() => mock.restore());

test("one archived run can contain multiple suites", async () => {
  serve({ [`https://huggingface.co/api/datasets/${upstreamRepo}/tree/main/runs/${runId}`]:
    ["gold.jsonl", "recall.json", "fresh.jsonl", "ndcg.json"].map(path => ({ path })) });
  expect((await describeRun(upstreamRepo, runId)).map(r => r.vertical)).toEqual(["finance", "news"]);
});

test("a scheduled refresh can defer a run that the index lists before its archive appears", async () => {
  serve({});
  expect(await describeRun(upstreamRepo, runId, { allowMissing: true })).toEqual([]);
  await expect(describeRun(upstreamRepo, runId)).rejects.toThrow("HTTP 404");
});

test("Scholar joins the evaluated sample to string-encoded gold by item identity", async () => {
  const input = (id: string) => ({
    query_text: "same title", query_id: id, gold: JSON.stringify({ paper_key: id, ids: { arxiv: id } }),
    query_origin: JSON.stringify({ bucket: "title", provenance: { title: "Paper " + id } }),
  });
  const result = (id: string) => ({ query: "same title", bucket: "title", paper_key: id, results: [], hit_rank: null });
  const report = { num_queries: 2, num_results: 10, engines: { exa: { per_query_path: "scholar/exa.json" } } };
  serve({
    "scholar.jsonl": [input("A"), input("B"), input("C")].map(r => JSON.stringify(r)).join("\n"),
    "scholar.json": report, "scholar/exa.json": { per_query: [result("C"), result("A")] },
  });
  const batch = await fetchBatch({ ...base, vertical: "scholar" });
  expect(batch.k).toBe(10);
  expect(batch.queries.map(q => q.queryId)).toEqual(["C", "A"]);
  expect(batch.queries[0].goldValue).toContain("Paper C");
});

test("Finance keeps every published field and its aligned provider results", async () => {
  const fields = ["lei", "ticker"];
  const inputs = fields.map((field) => ({
    query_id: field, query_text: `Find ${field}`, gold: { field, value: field.toUpperCase() },
  }));
  const results = fields.map((field) => ({ query: `Find ${field}`, field, results: [], hit_rank: null, search_error: null }));
  const metrics = { per_query_path: "finance/exa.json", recall_at_k: 0.5, mrr_at_k: 0.25, num_scored: 2 };
  serve({
    "gold.jsonl": inputs.toReversed().map(row => JSON.stringify(row)).join("\n"),
    "recall.json": { num_queries: 2, num_results: 5, engines: { exa: metrics } },
    "finance/exa.json": { per_query: results },
  });

  const batch = await fetchBatch({ ...base, vertical: "finance" });
  expect(batch.queries.map(query => query.field)).toEqual(fields);
  expect(batch.sourceRows.map(row => row.gold.field)).toEqual(fields);
  expect(batch.perEngine.exa).toEqual(results);
  expect(batch.publishedMetrics.exa).toEqual(metrics);
});
