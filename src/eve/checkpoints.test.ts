import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { EveEvalResult } from "eve/evals";
import { CaseCheckpoints } from "./checkpoints";
import { caseCheckpointKey, checkpointReporter, runNeedleEveSuite, type NeedleEveRunParams } from "./runner";

test("completed questions survive interruption and failed questions remain retryable", async () => {
  expect(isAbsolute(new CaseCheckpoints("relative-path").directory)).toBe(true);
  const root = await mkdtemp(join(tmpdir(), "needle-checkpoints-"));
  const sessions = join(root, "sessions");
  const session = join(sessions, "completed");
  const snapshot = { ref: "org/source:latest", id: "snapshot", tag: null, uri: null, documents: 1, labels: {} };
  const params: NeedleEveRunParams = {
    suite: "legal-agent", cases: [{ index: 0, queryText: "First question" }, { index: 1, queryText: "Second question" }],
    indexSnapshot: { ...snapshot, ref: "_/index:latest", id: "index" }, registry: "https://example.com",
    agentModel: "test/model", zeroDataRetention: true, k: 5, snippetChars: 2000, allowQueryRewrite: true, scope: "legal",
  };
  try {
    const store = new CaseCheckpoints("test-batch", root);
    const keys = Object.fromEntries(params.cases.map((row) => [row.index, caseCheckpointKey(params, row)]));
    await mkdir(session, { recursive: true });
    await writeFile(join(session, "accepted-results.json"), "[]");
    await writeFile(join(session, "turn-ms.json"), "120");
    const reporter = checkpointReporter(params, sessions, store.directory, keys);
    const result = { id: "legal-agent/0000", verdict: "passed", startedAt: new Date().toISOString(),
      result: { sessionId: "completed", derived: { toolCalls: [] } } } as unknown as EveEvalResult;
    await reporter.onEvalComplete(result);
    await reporter.onEvalComplete({ ...result, id: "legal-agent/0001", verdict: "failed", error: "Provider failed" });
    // A new process only needs the persisted case record to preserve the completed question.
    const resumed = new CaseCheckpoints("test-batch", root);
    expect(await resumed.read(keys[1])).toBeNull();
    const restored = await runNeedleEveSuite({ ...params, cases: [params.cases[0]] }, resumed);
    expect(restored.get(0)?.discovery).toMatchObject({ status: "not_found", projectScope: "legal" });
    expect(restored.get(0)?.timing?.agentMs).toBe(120);
    expect(restored.get(0)?.hits).toEqual([]);
    expect(caseCheckpointKey(params, { ...params.cases[0], queryText: "Changed question" })).not.toBe(keys[0]);
    expect(caseCheckpointKey({ ...params, indexSnapshot: { ...params.indexSnapshot, id: "other-index" } }, params.cases[0])).not.toBe(keys[0]);
    expect(caseCheckpointKey({ ...params, agentModel: "other/model" }, params.cases[0])).not.toBe(keys[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("question checkpoints skip data that requires URL redaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "needle-checkpoints-"));
  try {
    const checkpoints = new CaseCheckpoints("test-redaction", root);
    await checkpoints.save("case", { url: "https://example.com/paper?access_token=placeholder" });
    expect(await checkpoints.read("case")).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
