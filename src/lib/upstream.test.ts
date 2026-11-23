import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { describeRun, fetchBatch } from "./upstream";

const runId = "2026-11-22T1200Z";
const upstreamRepo = "fixture/results";
const base = { upstreamRepo, runId, slice: null };

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
