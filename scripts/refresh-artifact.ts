import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ledger, LedgerEntry, RunIndex, RunIndexEntry } from "../src/lib/types";

const runsPath = "public/runs";
const indexPath = join(runsPath, "index.json");
const ledgerPath = "data/ledger.json";

interface RunUpdate {
  entry: RunIndexEntry;
  ledgerEntry: LedgerEntry;
  previousRunDate: string | null;
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
      updates.push({ entry, ledgerEntry, previousRunDate });
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
  const pending = updates.filter(({ entry, previousRunDate }) => {
    checkRunId(entry.id);
    const currentRunDate = runs.get(entry.id)?.corpusRunDate ?? null;
    if (currentRunDate === entry.corpusRunDate) return false;
    if (currentRunDate !== previousRunDate) {
      throw new Error(`Benchmark ${entry.id} changed on main while this job was running.`);
    }
    return true;
  });
  if (!pending.length) return;

  for (const { entry, ledgerEntry } of pending) {
    const target = join(runsPath, entry.id);
    await rm(target, { recursive: true, force: true });
    await cp(join(source, "runs", entry.id), target, { recursive: true });
    runs.set(entry.id, entry);
    ledger.processed[entry.id] = ledgerEntry;
  }

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
