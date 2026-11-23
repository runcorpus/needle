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
  expect(paired.overall).toBeNull();
});

test("Overall compares normalized shares and requires measured coverage across all five suites", () => {
  const batches: MeasuredBatch[] = benchmarkSuites.map((suite) => ({
    id: suite,
    suite,
    questions: [{ queryId: "a", bucket: "all", score: 0.5, ultimate: 0.5 }],
  }));
  expect(aggregateCorpusWeek(batches).overall).toEqual({ mean: 1, interval: null });
  expect(aggregateCorpusWeek(batches.slice(1)).overall).toBeNull();
});

test("leaderboard bucket columns show zero recall and leave unavailable scores blank", () => {
  const columns = ["engine", "recall@5", "95% CI", "CASELAW", "CODE"];
  const runs = [{
    suite: "legal" as const,
    href: "/runs/legal",
    retrieval: 0,
    share: 0,
    simulated: false,
    byBucket: { caselaw: 0 },
  }];
  expect(reportCorpusRows("legal", columns, runs, null)).toEqual([
    ["Corpus (Agent)", "—", "—", "—", "—"],
    ["Corpus (NEEDLE)", "0.000", "—", "0.000", "—"],
  ]);
});
