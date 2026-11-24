import { expect, test } from "bun:test";
import { aggregateCorpusWeek, benchmarkSuites, type MeasuredBatch } from "./corpus-report";
import { reportCorpusRows } from "./report-results";

test("suite averages weight by scored questions and intervals require multiple measured runs", () => {
  const first: MeasuredBatch = {
    id: "newer",
    suite: "finance",
    questions: [{ queryId: "a", bucket: "filings", score: 1, ultimate: 1 }],
  };
  const second: MeasuredBatch = {
    id: "older",
    suite: "finance",
    questions: ["b", "c", "d"].map((queryId) => ({
      queryId,
      bucket: queryId === "d" ? "filingdoc" : "filings",
      score: 0,
      ultimate: 1,
    })),
  };
  const single = aggregateCorpusWeek([first]);
  expect(single.suites.finance?.score).toEqual({ mean: 1, interval: null });
  const paired = aggregateCorpusWeek([first, second]);
  expect(paired.suites.finance).toMatchObject({ runs: 2, questions: 4, latestRunId: "newer" });
  expect(paired.suites.finance?.score).toEqual({ mean: 0.25, interval: [0, 1] });
  expect(paired.suites.finance?.byBucket).toEqual({ filings: 1 / 3, filingdoc: 0 });
  expect(paired.overall).toEqual({ mean: 0.05, interval: null });
});

test("Overall counts unavailable suite shares as zero", () => {
  const batches: MeasuredBatch[] = benchmarkSuites.map((suite) => ({
    id: suite,
    suite,
    questions: [{ queryId: "a", bucket: "all", score: 0.5, ultimate: 0.5 }],
  }));
  expect(aggregateCorpusWeek(batches).overall).toEqual({ mean: 1, interval: null });
  const partial = aggregateCorpusWeek([
    batches[0],
    { ...batches[1], questions: [{ queryId: "b", bucket: "all", score: 0, ultimate: 1 }] },
    { ...batches[2], questions: [{ queryId: "c", bucket: "all", score: 0, ultimate: 0 }] },
  ]);
  expect(partial.overall).toEqual({ mean: 0.2, interval: null });
  expect(aggregateCorpusWeek([]).overall).toEqual({ mean: 0, interval: null });
  const legacyReport = { ...partial, overall: { mean: 0.5, interval: null }, windowEnd: "2026-11-24T00:00:00Z", latency: { search: null, agent: null } };
  expect(reportCorpusRows("overall", ["engine", "of ultimate", "95% CI"], [], legacyReport)).toEqual([
    ["Corpus (Agent)", "0%", "—"],
    ["Corpus (NEEDLE)", "20%", "—"],
  ]);
});

test("leaderboard bucket columns show zero recall and leave unavailable scores blank", () => {
  const columns = ["engine", "recall@5", "95% CI", "CASELAW", "CODE"];
  const runs = [{
    suite: "legal" as const,
    href: "/runs/legal",
    scores: { agent: null, needle: { retrieval: 0, share: 0, byBucket: { caselaw: 0 } } },
  }];
  expect(reportCorpusRows("legal", columns, runs, null)).toEqual([
    ["Corpus (Agent)", "—", "—", "—", "—"],
    ["Corpus (NEEDLE)", "0.000", "—", "0.000", "—"],
  ]);
});

test("Latest Overall counts missing full runs as zero", () => {
  const columns = ["engine", "of ultimate", "95% CI"];
  const runs = benchmarkSuites.map((suite) => ({
    suite,
    href: `/runs/${suite}`,
    scores: { agent: { retrieval: 0, share: 0 }, needle: { retrieval: 0.25, share: 0.5 } },
  }));
  expect(reportCorpusRows("overall", columns, runs, null)).toEqual([
    ["Corpus (Agent)", "0%", "—"],
    ["Corpus (NEEDLE)", "50%", "—"],
  ]);
  expect(reportCorpusRows("overall", columns, runs.slice(1), null)).toEqual([
    ["Corpus (Agent)", "0%", "—"],
    ["Corpus (NEEDLE)", "40%", "—"],
  ]);
});
