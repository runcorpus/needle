import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCsv } from "../src/lib/runs";
import type { Ledger, LedgerEntry, NeedleCompatibleArtifact, RankedEvidence, RetrievalHarnessId, RunIndex, RunIndexEntry, RunManifest } from "../src/lib/types";

const runsPath = "public/runs";
const indexPath = join(runsPath, "index.json");
const ledgerPath = "data/ledger.json";

interface RunUpdate {
  entry: RunIndexEntry;
  ledgerEntry: LedgerEntry;
  previousRunDate: string | null;
  previousExecutions?: Partial<Record<RetrievalHarnessId, string | null>>;
}

function git(...args: string[]) {
  return execFileSync("git", args, { encoding: "utf8" });
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8"));
}

function writeJson(path: string, data: unknown) {
  return writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

function checkRunId(id: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{4}Z-[a-z_]+(?:-[a-z0-9_-]+)?$/.test(id)) {
    throw new Error(`Invalid benchmark run ID: ${id}`);
  }
}

async function pack(destination: string) {
  git("add", "-A", "--", runsPath);
  const changedPaths = git("diff", "--cached", "--name-only", "-z", "--", runsPath).split("\0");
  const ids = new Set(changedPaths.flatMap((path) => {
    const [, , id, file] = path.split("/");
    return file ? [id] : [];
  }));

  if (ids.size) {
    const base = JSON.parse(git("show", `HEAD:${indexPath}`)) as RunIndex;
    const index = await readJson<RunIndex>(indexPath);
    const ledger = await readJson<Ledger>(ledgerPath);
    const baseLedger = JSON.parse(git("show", `HEAD:${ledgerPath}`)) as Ledger;
    const updates: RunUpdate[] = [];
    await mkdir(join(destination, "runs"), { recursive: true });

    for (const id of ids) {
      checkRunId(id);
      const entry = index.runs.find((run) => run.id === id);
      const ledgerEntry = ledger.processed[id];
      if (!entry || !ledgerEntry || entry.sampleSize || entry.simulated) {
        throw new Error(`Missing published benchmark records for ${id}`);
      }
      const previousRunDate = base.runs.find((run) => run.id === id)?.corpusRunDate ?? null;
      const previousExecutions = Object.fromEntries((["needle-compatible", "agent"] as const)
        .filter((mode) => changedPaths.includes(`${runsPath}/${id}/${mode}.json`))
        .map((mode) => [mode, baseLedger.processed[id]?.harnesses[mode]?.executedAt ?? null]));
      if (!Object.keys(previousExecutions).length) throw new Error(`No changed mode artifact for ${id}`);
      updates.push({ entry, ledgerEntry, previousRunDate, previousExecutions });
      await cp(join(runsPath, id), join(destination, "runs", id), { recursive: true });
    }

    await writeJson(join(destination, "updates.json"), updates);
  }
  console.log(`Packed ${ids.size} changed benchmark runs.`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `has_results=${ids.size > 0}\n`);
  }
}

async function merge(source: string) {
  const updates = await readJson<RunUpdate[]>(join(source, "updates.json"));
  const index = await readJson<RunIndex>(indexPath);
  const ledger = await readJson<Ledger>(ledgerPath);
  const runs = new Map(index.runs.map((run) => [run.id, run]));
  const pending = updates.filter(({ entry, previousRunDate, previousExecutions }) => {
    checkRunId(entry.id);
    if (previousExecutions) return true;
    const currentRunDate = runs.get(entry.id)?.corpusRunDate ?? null;
    if (currentRunDate === entry.corpusRunDate) return false;
    if (currentRunDate !== previousRunDate) {
      throw new Error(`Benchmark ${entry.id} changed on main while this job was running.`);
    }
    return true;
  });
  if (!pending.length) return;

  let changed = false;
  for (const { entry, ledgerEntry, previousExecutions } of pending) {
    const target = join(runsPath, entry.id);
    if (previousExecutions) {
      const modes = Object.entries(previousExecutions).filter(([mode, previous]) => {
        if (mode !== "agent" && mode !== "needle-compatible") throw new Error(`Invalid harness: ${mode}`);
        const current = ledger.processed[entry.id]?.harnesses[mode]?.executedAt ?? null;
        if (current === ledgerEntry.harnesses[mode]?.executedAt) return false;
        if (current !== previous) throw new Error(`${entry.id}/${mode} changed on main while this job was running.`);
        return true;
      }).map(([mode]) => mode as RetrievalHarnessId);
      if (!modes.length) continue;
      const incoming = join(source, "runs", entry.id);
      const manifest = await readJson<RunManifest>(join(incoming, "manifest.json"));
      let currentManifest: RunManifest | null = null;
      try { currentManifest = await readJson<RunManifest>(join(target, "manifest.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (currentManifest && currentManifest.corpus.indexSnapshot.id !== manifest.corpus.indexSnapshot.id) {
        throw new Error(`Cannot merge different Library snapshots for ${entry.id}.`);
      }
      for (const snapshot of Object.values(manifest.corpus.resolvedCorpora)) {
        const current = currentManifest?.corpus.resolvedCorpora[snapshot.ref];
        if (current && current.id !== snapshot.id) throw new Error(`Cannot merge different snapshots for ${snapshot.ref}.`);
      }
      await mkdir(join(target, "evidence"), { recursive: true });
      try {
        const currentInputs = await readJson(join(target, "inputs.json"));
        if (JSON.stringify(currentInputs) !== JSON.stringify(await readJson(join(incoming, "inputs.json")))) {
          throw new Error(`Cannot merge different question inputs for ${entry.id}.`);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const mode of modes) {
        const artifact = await readJson<NeedleCompatibleArtifact>(join(incoming, `${mode}.json`));
        await cp(join(incoming, `${mode}.json`), join(target, `${mode}.json`));
        if (artifact.retrievalFile) {
          if (artifact.retrievalFile !== `${mode}.retrieval.jsonl`) throw new Error("Unexpected retrieval filename.");
          await cp(join(incoming, artifact.retrievalFile), join(target, artifact.retrievalFile));
        }
        for (const question of artifact.questions) {
          if (!question.evidenceFile) continue;
          if (!Number.isSafeInteger(question.index) || question.index < 0) throw new Error("Invalid question index.");
          const file = join("evidence", `${question.index}.json`);
          const evidence = await readJson<Record<string, RankedEvidence[]>>(join(incoming, file));
          let existing = {};
          try { existing = await readJson(join(target, file)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          const ownEvidence = Object.fromEntries(Object.entries(evidence).filter(([engine]) =>
            !["corpus", "corpus-agent"].includes(engine) || engine === question.corpusNeedle.engine));
          await writeJson(join(target, file), { ...existing, ...ownEvidence });
        }
      }
      manifest.harnesses = { ...manifest.harnesses,
        ...(currentManifest ? Object.fromEntries(Object.entries(currentManifest.harnesses).filter(([key]) => !modes.includes(key as RetrievalHarnessId))) : {}) };
      await cp(join(incoming, "inputs.json"), join(target, "inputs.json"));
      const date = [entry.corpusRunDate, currentManifest?.corpusRunDate ?? ""].sort().at(-1)!;
      manifest.corpusRunDate = date;
      manifest.corpus.resolvedCorpora = { ...currentManifest?.corpus.resolvedCorpora, ...manifest.corpus.resolvedCorpora };
      manifest.files = { ...currentManifest?.files, ...manifest.files };
      if (manifest.harnesses.agent) manifest.files.agent = manifest.harnesses.agent.artifact;
      await writeJson(join(target, "manifest.json"), manifest);
      const artifacts = await Promise.all((["needle-compatible", "agent"] as const).map(async (mode) => {
        try { return await readJson<NeedleCompatibleArtifact>(join(target, `${mode}.json`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      }));
      const [needle, agent] = artifacts;
      await writeFile(join(target, "scores.csv"), buildCsv(needle, agent));
      const needleRow = needle?.providers.find((provider) => provider.isCorpus);
      const agentRow = agent?.providers.find((provider) => provider.isCorpus);
      const discovery = needle ?? agent;
      runs.set(entry.id, {
        ...runs.get(entry.id), ...entry, corpusRunDate: date,
        corpusNeedleRecallAtK: needleRow?.recallAtK ?? null,
        corpusNeedleMrrAtK: needleRow?.mrrAtK ?? null,
        ...(needleRow?.meanNdcg !== undefined ? { corpusNeedleMeanNdcg: needleRow.meanNdcg } : {}),
        ...(agentRow ? { corpusAgentRecallAtK: agentRow.recallAtK,
          ...(agentRow.meanNdcg !== undefined ? { corpusAgentMeanNdcg: agentRow.meanNdcg } : {}),
          agentPath: manifest.files.agent } : {}),
        discoveryRate: discovery ? discovery.questions.filter((question) => question.discovery.status === "found").length / discovery.questions.length : null,
      });
      ledger.processed[entry.id] = { ...ledgerEntry, harnesses: {
        ...ledger.processed[entry.id]?.harnesses,
        ...Object.fromEntries(modes.map((mode) => [mode, ledgerEntry.harnesses[mode]])),
      } };
      changed = true;
      continue;
    }
    await rm(target, { recursive: true, force: true });
    await cp(join(source, "runs", entry.id), target, { recursive: true });
    runs.set(entry.id, entry);
    ledger.processed[entry.id] = ledgerEntry;
    changed = true;
  }

  if (!changed) return;
  index.updatedAt = new Date().toISOString();
  index.runs = [...runs.values()].sort((a, b) => Date.parse(b.upstreamRunDate) - Date.parse(a.upstreamRunDate));
  ledger.version = 2;
  await writeJson(indexPath, index);
  await writeJson(ledgerPath, ledger);
}

const [mode, path] = process.argv.slice(2);
if (!path || (mode !== "pack" && mode !== "merge")) {
  throw new Error("Usage: refresh-artifact.ts <pack|merge> <artifact-directory>");
}
await (mode === "pack" ? pack(path) : merge(path));
