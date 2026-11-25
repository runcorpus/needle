import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { publicRunJson } from "../lib/public-run-json";
import type { CorpusSnapshotRef } from "../lib/types";

export function checkpointDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class CaseCheckpoints {
  private readonly prefix: string;
  readonly directory: string;
  private readonly uploaded = new Set<string>();
  private readonly uploads = new Map<string, Promise<void>>();

  constructor(identity: unknown, root = ".evals/checkpoints") {
    this.prefix = `needle-cases-${checkpointDigest(identity)}`;
    this.directory = resolve(root, this.prefix);
  }

  async read(name: string): Promise<unknown> {
    const file = join(this.directory, `${name}.json`);
    try {
      let json = await this.readFile(file);
      if (json === null && process.env.ACTIONS_RUNTIME_TOKEN) {
        const { restoreCache } = await import("@actions/cache");
        const key = `${this.prefix}-${name}`;
        const restored = await restoreCache([file], key);
        if (restored === key) {
          json = await this.readFile(file);
          this.uploaded.add(`${name}.json`);
        }
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
    const file = join(this.directory, `${name}.json`);
    const pending = join(this.directory, `${randomUUID()}.tmp`);
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(pending, json);
      await rename(pending, file);
    } finally {
      await rm(pending, { force: true });
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (!process.env.ACTIONS_RUNTIME_TOKEN) return;
    const files = await readdir(this.directory).catch(() => [] as string[]);
    for (const name of files.filter((name) => name.endsWith(".json") && !this.uploaded.has(name) && !this.uploads.has(name))) {
      const task = this.upload(name).finally(() => { this.uploads.delete(name); });
      this.uploads.set(name, task);
    }
    await Promise.all(this.uploads.values());
  }

  private async upload(name: string) {
    try {
      const { saveCache } = await import("@actions/cache");
      const id = await saveCache([join(this.directory, name)], `${this.prefix}-${name.slice(0, -5)}`);
      if (id < 0) console.warn(`[checkpoint] ${name} remains available locally.`);
      this.uploaded.add(name);
    } catch (error) {
      console.warn(`[checkpoint] Could not save ${name} to GitHub Actions: ${error}`);
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

export async function retrievalFingerprint() {
  const hash = createHash("sha256");
  for (const file of (await readdir("src/eve")).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort()) {
    hash.update(file).update(await readFile(join("src/eve", file)));
  }
  for (const file of ["src/lib/corpus-cli.ts", "src/lib/corpus-socket.ts", "bun.lock"]) hash.update(await readFile(file));
  return hash.digest("hex");
}
