import { describe, expect, test } from "bun:test";
import { computeRecallAndMrr, firstHitRank, matchGoldEvidence } from "./needle-scorer";

describe("NEEDLE Finance deterministic scorer", () => {
  test("matches 20-char LEI in URL even when description omits LEI", () => {
    const res = matchGoldEvidence({
      field: "lei",
      fieldType: "exact_id",
      value: "INR2EJN1ERAN0W5ZP974",
      title: "MICROSOFT CORPORATION",
      snippet: "Active US legal entity based in Tumwater.",
      url: "https://api.gleif.org/api/v1/lei-records/INR2EJN1ERAN0W5ZP974",
    });
    expect(res.matched).toBe(true);
    expect(res.matchedIn).toBe("url");
    expect(res.reason).toContain("INR2EJN1ERAN0W5ZP974");
  });

  test("matches LEI in snippet regardless of hyphens or casing", () => {
    const res = matchGoldEvidence({
      field: "lei",
      fieldType: "exact_id",
      value: "549300UVN46B3BBDHO85",
      title: "Palantir Profile",
      snippet: "Official LEI code: 549300-uvn46b-3bbdho85 (issued)",
      url: "https://example.com/palantir",
    });
    expect(res.matched).toBe(true);
    expect(res.matchedIn).toBe("snippet");
  });

  test("misses LEI when absent beyond 2,000-char snippet cap", () => {
    const padded = `${"x".repeat(2050)} 549300UVN46B3BBDHO85`;
    const res = matchGoldEvidence({
      field: "lei",
      fieldType: "exact_id",
      value: "549300UVN46B3BBDHO85",
      title: "Palantir Profile",
      snippet: padded,
      url: "https://example.com/palantir",
      snippetChars: 2000,
    });
    expect(res.matched).toBe(false);
    expect(res.matchedIn).toBe("none");
  });

  test("computes Recall@K and MRR@K accurately", () => {
    expect(firstHitRank([false, true, true])).toBe(2);
    expect(firstHitRank([false, false])).toBe(null);

    const metrics = computeRecallAndMrr([1, 2, null, 4]);
    expect(metrics.hits).toBe(3);
    expect(metrics.scored).toBe(4);
    expect(metrics.recall).toBeCloseTo(0.75, 6);
    expect(metrics.mrr).toBeCloseTo((1 + 0.5 + 0 + 0.25) / 4, 6);
  });
});
