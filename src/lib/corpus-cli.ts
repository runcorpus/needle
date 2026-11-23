import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CorpusSearchHit, CorpusSnapshotRef, DiscoveryIndexHit } from "./types";

function resolveCorpusBin(): string {
  if (process.env.CORPUS_BIN) return process.env.CORPUS_BIN;
  const homeBin = join(homedir(), ".corpus", "bin", "corpus");
  if (existsSync(homeBin)) return homeBin;
  return "corpus";
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Uses standard Node.js `child_process.spawn` so CorpusClient works identically
 * under both Bun scripts and Node.js >= 24 (required by Eve 1.0.0).
 */
function execCorpus(args: string[]): Promise<ExecResult> {
  const bin = resolveCorpusBin();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${join(homedir(), ".corpus", "bin")}:${process.env.PATH ?? ""}`,
      },
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    });
  });
}

export class CorpusClient {
  private readonly registry: string;
  private readonly attachedCache = new Map<string, CorpusSnapshotRef>();

  constructor(registry = "https://library.runcorpus.com") {
    this.registry = registry.replace(/\/+$/, "");
  }

  async version(): Promise<string> {
    const res = await execCorpus(["--version"]);
    if (res.exitCode !== 0) {
      throw new Error(`corpus --version failed: ${res.stderr.trim()}`);
    }
    return res.stdout.trim();
  }

  async ensureDaemonStarted(): Promise<void> {
    const status = await execCorpus(["status", "--json"]);
    if (status.exitCode === 0) return;
    const start = await execCorpus(["daemon", "start"]);
    if (start.exitCode !== 0) {
      throw new Error(`corpus daemon start failed: ${start.stderr.trim() || start.stdout.trim()}`);
    }
  }

  async resolveLatestTag(corpusSlug: string): Promise<string> {
    if (corpusSlug.includes(":")) return corpusSlug;
    const url = `${this.registry}/${corpusSlug}/tags`;
    const res = await fetch(url, { headers: { "User-Agent": "runcorpus-needle/0.1" } });
    if (!res.ok) {
      throw new Error(`Failed to list tags for ${corpusSlug} (${res.status})`);
    }
    const body = (await res.json()) as { tags?: string[] };
    const tags = body.tags ?? [];
    if (tags.length === 0) {
      throw new Error(`No published tags found for ${corpusSlug} at ${this.registry}`);
    }
    if (tags.includes("latest")) return `${corpusSlug}:latest`;
    const sorted = [...tags].sort();
    return `${corpusSlug}:${sorted[sorted.length - 1]}`;
  }

  async attachAndInfo(refOrSlug: string): Promise<CorpusSnapshotRef> {
    const qualified = refOrSlug.includes(":") ? refOrSlug : await this.resolveLatestTag(refOrSlug);
    const cached = this.attachedCache.get(qualified);
    if (cached) return cached;

    let infoRes = await execCorpus(["info", qualified, "--json"]);
    if (infoRes.exitCode !== 0) {
      const addRes = await execCorpus(["add", qualified]);
      // Another eval may attach the same corpus between the info and add calls.
      infoRes = await execCorpus(["info", qualified, "--json"]);
      if (infoRes.exitCode !== 0) {
        if (addRes.exitCode !== 0) {
          throw new Error(`corpus add ${qualified} failed: ${addRes.stderr.trim() || addRes.stdout.trim()}`);
        }
        throw new Error(`corpus info ${qualified} failed: ${infoRes.stderr.trim()}`);
      }
    }

    const parsed = JSON.parse(infoRes.stdout) as {
      id: string;
      tags?: string[];
      uri?: string | null;
      documents?: number;
      labels?: Record<string, string>;
    };

    const snapshot: CorpusSnapshotRef = {
      ref: qualified,
      tag: parsed.tags?.[0] ?? qualified,
      id: parsed.id,
      uri: parsed.uri ?? null,
      documents: parsed.documents ?? 0,
      labels: parsed.labels ?? {},
    };
    this.attachedCache.set(qualified, snapshot);
    this.attachedCache.set(snapshot.id, snapshot);
    return snapshot;
  }

  async attachPinned(snapshot: CorpusSnapshotRef): Promise<CorpusSnapshotRef> {
    if (this.attachedCache.has(snapshot.id)) return snapshot;
    const existing = await execCorpus(["info", snapshot.id, "--json"]);
    if (existing.exitCode !== 0) {
      const ref = snapshot.uri ?? snapshot.ref;
      const added = await execCorpus(["add", ref]);
      const attached = await execCorpus(["info", snapshot.id, "--json"]);
      if (attached.exitCode !== 0) {
        throw new Error(`Could not attach pinned snapshot ${snapshot.id} for ${snapshot.ref}: ${added.stderr.trim() || attached.stderr.trim()}`);
      }
    }
    this.attachedCache.set(snapshot.id, snapshot);
    return snapshot;
  }

  async search(refOrId: string, query: string, k = 5): Promise<CorpusSearchHit[]> {
    const res = await execCorpus(["search", "--json", "-k", String(k), "--query", query, refOrId]);
    if (res.exitCode !== 0 && res.exitCode !== 1) {
      throw new Error(`corpus search failed (${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const raw = res.stdout.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { hits?: CorpusSearchHit[] };
    return parsed.hits ?? [];
  }

  async searchIndex(indexRef: string, query: string, k = 5): Promise<DiscoveryIndexHit[]> {
    const hits = await this.search(indexRef, query, k);
    return hits
      .map((hit) => {
        const corpusMeta =
          typeof hit.meta.corpus === "string"
            ? hit.meta.corpus
            : hit.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/+$/, "");
        return {
          corpus: corpusMeta,
          title: hit.meta.title ?? corpusMeta,
          description: hit.meta.description ?? "",
          score: hit.score,
        };
      })
      .filter((h) => Boolean(h.corpus) && h.corpus !== "_/index");
  }
}
