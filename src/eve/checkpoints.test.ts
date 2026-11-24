import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CorpusSnapshotRef } from "../lib/types";
import { runScholarGroups, ScholarCheckpoints } from "./checkpoints";

test("Scholar resumes completed groups and reuses their corpus pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "needle-checkpoints-"));
  try {
    const cases = Array.from({ length: 36 }, (_, index) => ({ index, queryText: `Question ${index}` }));
    const snapshot: CorpusSnapshotRef = {
      ref: "example/papers:latest", id: "snapshot-a", tag: null, uri: null, documents: 1, labels: {},
    };
    const result = { discovery: { status: "found" }, snapshots: [snapshot] };
    const groupsRun: number[] = [];
    let interrupted = true;
    const run = (indexId: string, initialPins?: Record<string, CorpusSnapshotRef>) => runScholarGroups({
      checkpoints: new ScholarCheckpoints("test-batch", root),
      suite: "scholar-retrieval",
      cases,
      indexId,
      initialPins,
      isResult: (value): value is typeof result => !!value && typeof value === "object" && "snapshots" in value,
      async runGroup(group, start, pins) {
        groupsRun.push(start);
        if (start > 0) {
          expect(pins[snapshot.ref]).toEqual(snapshot);
          if (interrupted) throw new Error("Interrupted");
        }
        return new Map(group.map(({ index }) => [index, result]));
      },
    });

    await expect(run("index-a")).rejects.toThrow("Interrupted");
    interrupted = false;
    expect([...(await run("index-a")).keys()]).toEqual(cases.map(({ index }) => index));
    expect(groupsRun).toEqual([0, 32, 32]);
    await run("index-a", { "example/unrelated:latest": { ...snapshot, ref: "example/unrelated:latest" } });
    expect(groupsRun).toEqual([0, 32, 32]);
    await run("index-b");
    expect(groupsRun).toEqual([0, 32, 32, 0, 32]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Scholar checkpoints skip data that requires URL redaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "needle-checkpoints-"));
  try {
    const checkpoints = new ScholarCheckpoints("test-redaction", root);
    await checkpoints.save("group", { url: "https://example.com/paper?access_token=placeholder" });
    expect(await checkpoints.read("group")).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
