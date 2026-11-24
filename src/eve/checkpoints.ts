import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publicRunJson } from "../lib/public-run-json";
import type { CorpusSnapshotRef } from "../lib/types";
import type { NeedleEveCase } from "./needle-retrieval";

const groupSize = 32;

export function checkpointDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class ScholarCheckpoints {
  private readonly prefix: string;
  private readonly dir: string;

  constructor(identity: unknown, root = ".evals/checkpoints") {
    this.prefix = `needle-scholar-v1-${checkpointDigest(identity)}`;
    this.dir = join(root, this.prefix);
  }

  async read(name: string): Promise<unknown> {
    const file = join(this.dir, `${name}.json`);
    try {
      let json = await this.readFile(file);
      if (json === null && process.env.ACTIONS_RUNTIME_TOKEN) {
        const { restoreCache } = await import("@actions/cache");
        const key = `${this.prefix}-${name}`;
        const restored = await restoreCache([file], key);
        if (restored === key) json = await this.readFile(file);
        else if (restored) await rm(file, { force: true });
      }
      if (json === null) return null;
      const value = JSON.parse(json);
      return publicRunJson(value) === JSON.stringify(value) ? value : null;
    } catch (error) {
      console.warn(`[checkpoint] Could not read ${name}: ${error}`);
      return null;
    }
  }

  async save(name: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    if (publicRunJson(value) !== json) {
      console.warn(`[checkpoint] Skipping ${name} because its data includes a URL that needs redaction.`);
      return;
    }
    const file = join(this.dir, `${name}.json`);
    const pending = join(this.dir, `${randomUUID()}.tmp`);
    await mkdir(this.dir, { recursive: true });
    try {
      await writeFile(pending, json);
      await rename(pending, file);
    } finally {
      await rm(pending, { force: true });
    }
    if (process.env.ACTIONS_RUNTIME_TOKEN) {
      try {
        const { saveCache } = await import("@actions/cache");
        if (await saveCache([file], `${this.prefix}-${name}`) < 0) {
          console.warn(`[checkpoint] ${name} was saved on this runner only.`);
        }
      } catch (error) {
        console.warn(`[checkpoint] Could not save ${name} to GitHub Actions: ${error}`);
      }
    }
  }

  private async readFile(file: string) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }
}

export function isCheckpointSnapshot(value: unknown): value is CorpusSnapshotRef {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<CorpusSnapshotRef>;
  return typeof snapshot.ref === "string" && typeof snapshot.id === "string"
    && (snapshot.uri === null || typeof snapshot.uri === "string")
    && (snapshot.tag === null || typeof snapshot.tag === "string")
    && typeof snapshot.documents === "number" && !!snapshot.labels && typeof snapshot.labels === "object";
}

export async function runScholarGroups<T extends { discovery: { status: string }; snapshots: CorpusSnapshotRef[] }>(options: {
  checkpoints: ScholarCheckpoints;
  suite: string;
  cases: NeedleEveCase[];
  indexId: string;
  initialPins?: Record<string, CorpusSnapshotRef>;
  isResult(value: unknown): value is T;
  runGroup(cases: NeedleEveCase[], group: number, pins: Record<string, CorpusSnapshotRef>): Promise<Map<number, T>>;
}): Promise<Map<number, T>> {
  const { checkpoints, suite, cases, indexId, initialPins, isResult, runGroup } = options;
  const pins = new Map(Object.values(initialPins ?? {}).map((snapshot) => [snapshot.ref.split(":")[0], snapshot]));
  const results = new Map<number, T>();

  for (let start = 0; start < cases.length; start += groupSize) {
    const group = cases.slice(start, start + groupSize);
    const compatible = (saved: unknown): saved is [number, T][] =>
      Array.isArray(saved) && saved.length === group.length && saved.every((entry, i) => {
        if (!Array.isArray(entry) || entry[0] !== group[i].index || !isResult(entry[1])) return false;
        return entry[1].snapshots.every(({ ref, id }: CorpusSnapshotRef) => {
          const pin = pins.get(ref.split(":")[0]);
          return !pin || (pin.ref === ref && pin.id === id);
        });
      });
    let key = `${suite}-${start}-${checkpointDigest([indexId, group])}`;
    let saved = await checkpoints.read(key);
    if (saved && !compatible(saved)) {
      // A paired run may have since recorded a different snapshot for a corpus this group searched.
      key = `${key}-${checkpointDigest([...pins.values()].map(({ ref, id }) => [ref, id]).sort())}`;
      saved = await checkpoints.read(key);
    }
    const restored = compatible(saved) ? saved : null;
    const entries = restored ? new Map<number, T>(restored) : await runGroup(group, start, Object.fromEntries(
      [...pins.values()].map((snapshot) => [snapshot.ref, snapshot]),
    ));
    if (entries.size !== group.length || group.some(({ index }) => !entries.has(index))) {
      throw new Error(`${suite} returned incomplete results for questions ${start + 1}–${start + group.length}.`);
    }
    if (!restored && [...entries.values()].some(({ discovery }) => discovery.status !== "error")) {
      await checkpoints.save(key, group.map(({ index }) => [index, entries.get(index)]));
    }
    for (const { index } of group) {
      const result = entries.get(index)!;
      results.set(index, result);
      for (const snapshot of result.snapshots) {
        const slug = snapshot.ref.split(":")[0];
        if (!pins.has(slug)) pins.set(slug, snapshot);
      }
    }
    const passed = [...results.values()].filter(({ discovery }) => discovery.status !== "error").length;
    console.log(`[${suite}] ${results.size}/${cases.length} finished (${passed} completed, ${results.size - passed} errors; ${restored ? "restored" : "ran"} questions ${start + 1}–${start + group.length})`);
  }
  return results;
}
