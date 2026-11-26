import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CaseCheckpoints } from "../src/eve/checkpoints";
import { CorpusClient } from "../src/lib/corpus-cli";
import { publicRunJson } from "../src/lib/public-run-json";
import { loadConfig } from "../src/lib/refresh-plan";
import type { CorpusSnapshotRef, NeedleCompatibleArtifact } from "../src/lib/types";

const destination = process.argv[2];
const { RUN_ID: runId, VERTICAL: vertical, SLICE: slice } = process.env;
if (!destination || !runId || !vertical) throw new Error("Provide an output path, RUN_ID, and VERTICAL.");
const config = await loadConfig();
const suite = config.verticals.find(({ id }) => id === vertical);
if (!suite) throw new Error(`Unknown suite: ${vertical}`);
const runSlug = [runId, vertical, slice === "all" ? null : slice || suite.slice].filter(Boolean).join("-");
const corpus = new CorpusClient(config.corpusRegistry);
const checkpoints = new CaseCheckpoints({
  purpose: "shared-snapshots", runSlug, registry: config.corpusRegistry, index: config.corpusIndex,
  cliVersion: await corpus.version(), namespace: process.env.BENCH_CHECKPOINT_NAMESPACE,
});
let snapshots = await checkpoints.read("snapshots");
if (!snapshots) {
  let indexSnapshot: CorpusSnapshotRef | undefined;
  const resolvedCorpora: Record<string, CorpusSnapshotRef> = {};
  for (const mode of ["needle-compatible", "agent"]) {
    const path = join("public/runs", runSlug, `${mode}.json`);
    let previous: NeedleCompatibleArtifact;
    try { previous = JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (previous.grading !== "needle" || previous.discoveryMode !== "eve") continue;
    if (indexSnapshot && indexSnapshot.id !== previous.indexSnapshot.id) throw new Error("Recorded modes have different Library snapshots.");
    indexSnapshot = previous.indexSnapshot;
    for (const snapshot of Object.values(previous.resolvedCorpora)) {
      if (resolvedCorpora[snapshot.ref] && resolvedCorpora[snapshot.ref].id !== snapshot.id) {
        throw new Error(`Recorded modes have different snapshots for ${snapshot.ref}.`);
      }
      resolvedCorpora[snapshot.ref] = snapshot;
    }
  }
  indexSnapshot = indexSnapshot ? await corpus.attachPinned(indexSnapshot) : await corpus.attachAndInfo(config.corpusIndex);
  // Enumerate public collection metadata; retrieval and snapshot validation use MCP.
  const catalogResponse = await fetch(`${config.corpusRegistry}/`);
  if (!catalogResponse.ok) throw new Error(`Cannot list published Library corpus (${catalogResponse.status}).`);
  const catalog = await catalogResponse.json() as { corpus: Array<{ id: string }> };
  for (const { id: slug } of catalog.corpus) {
    const response = await fetch(`${config.corpusRegistry}/${slug}/tags`);
    if (!response.ok) throw new Error(`Cannot list tags for ${slug}: ${response.status}`);
    const { tags } = await response.json() as { tags: string[] };
    if (!tags.length) throw new Error(`No published tags for ${slug}.`);
    // Put the default last, matching the retrieval agent's untagged-reference resolution.
    for (const tag of tags.filter((tag) => tag !== "latest").sort().concat(tags.includes("latest") ? ["latest"] : [])) {
      const ref = `${slug}:${tag}`;
      resolvedCorpora[ref] ??= await corpus.attachAndInfo(ref);
    }
  }
  const orderedCorpora = Object.fromEntries(Object.entries(resolvedCorpora).sort(([a], [b]) =>
    Number(a.endsWith(":latest")) - Number(b.endsWith(":latest")) || a.localeCompare(b)));
  snapshots = { registry: config.corpusRegistry, runSlug, indexSnapshot, resolvedCorpora: orderedCorpora };
  await checkpoints.save("snapshots", snapshots);
}
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${publicRunJson(snapshots, 2)}\n`);
console.log(`Prepared shared snapshots for ${runSlug}: ${destination}`);
