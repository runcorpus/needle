import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CorpusSearchHit, CorpusSnapshotRef, DiscoveryIndexHit } from "./types";
import { SocketClient, type RequestOptions } from "./corpus-socket";

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
  private readonly attachingCache = new Map<string, Promise<CorpusSnapshotRef>>();
  private readonly socket = new SocketClient();

  private registryReference(ref: string) {
    return /^[a-f0-9]{64}$/i.test(ref) || /^https?:\/\//.test(ref) ? ref : `${this.registry}/${ref}`;
  }

  private manifestUri(ref: string, snapshotId?: string) {
    let uri = this.registryReference(ref)
      .replace(/@sha256:([a-f0-9]{64})$/, "/sha256/$1")
      .replace(/:([^/:]+)$/, "/tags/$1");
    if (!/\/(?:tags|sha256)\/[^/]+$/.test(uri)) uri += "/tags/latest";
    return snapshotId ? uri.replace(/\/(?:tags|sha256)\/[^/]+$/, `/sha256/${snapshotId}`) : uri;
  }

  private info(ref: string, options?: RequestOptions) {
    const identifier = this.registryReference(ref);
    return this.socket.request("GET", `/v0/corpus/${encodeURIComponent(identifier)}`, undefined, options) as Promise<{
      id: string; tags?: string[]; uri?: string | null; documents?: number; labels?: Record<string, string>;
    }>;
  }

  constructor(registry = "https://library.runcorpus.com", indexSnapshot?: CorpusSnapshotRef) {
    this.registry = registry.replace(/\/+$/, "");
    if (indexSnapshot) {
      this.attachedCache.set(indexSnapshot.ref, indexSnapshot);
      this.attachedCache.set(indexSnapshot.id, indexSnapshot);
    }
  }

  async version(): Promise<string> {
    const res = await execCorpus(["--version"]);
    if (res.exitCode !== 0) {
      throw new Error(`corpus --version failed: ${res.stderr.trim()}`);
    }
    return res.stdout.trim();
  }

  async ensureDaemonStarted(): Promise<void> {
    try { await this.socket.request("GET", "/v0/status"); return; } catch { /* Start through the installed CLI. */ }
    const start = await execCorpus(["daemon", "start"]);
    if (start.exitCode !== 0) {
      throw new Error(`corpus daemon start failed: ${start.stderr.trim() || start.stdout.trim()}`);
    }
  }

  async resolveLatestTag(corpusSlug: string, options?: RequestOptions): Promise<string> {
    if (corpusSlug.includes(":")) return corpusSlug;
    const url = `${this.registry}/${corpusSlug}/tags`;
    const res = await fetch(url, { headers: { "User-Agent": "runcorpus-needle/0.1", ...options?.traceContext }, signal: options?.signal });
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

  async attachAndInfo(refOrSlug: string, options?: RequestOptions): Promise<CorpusSnapshotRef> {
    const qualified = refOrSlug.includes(":") ? refOrSlug : await this.resolveLatestTag(refOrSlug, options);
    const cached = this.attachedCache.get(qualified);
    if (cached) return cached;
    const pending = this.attachingCache.get(qualified);
    if (pending) return pending;

    const promise = (async () => {
      // Resolve the published tag on first attachment, even if the daemon already
      // has an older local tag. Cache the resolved snapshot for this client.
      const added = await this.socket.request("POST", "/v0/corpus", { uri: this.manifestUri(qualified) }, options) as { id: string };
      const parsed = await this.info(added.id, options);

      const snapshot: CorpusSnapshotRef = {
        ref: qualified,
        tag: parsed.tags?.[0] ?? qualified,
        id: parsed.id,
        uri: this.manifestUri(qualified, parsed.id),
        documents: parsed.documents ?? 0,
        labels: parsed.labels ?? {},
      };
      this.attachedCache.set(qualified, snapshot);
      this.attachedCache.set(snapshot.id, snapshot);
      return snapshot;
    })();

    this.attachingCache.set(qualified, promise);
    try {
      return await promise;
    } finally {
      this.attachingCache.delete(qualified);
    }
  }

  async attachPinned(snapshot: CorpusSnapshotRef, options?: RequestOptions): Promise<CorpusSnapshotRef> {
    if (this.attachedCache.has(snapshot.id)) return snapshot;
    const pending = this.attachingCache.get(snapshot.id);
    if (pending) return pending;

    const promise = (async () => {
      await this.info(snapshot.id, options).catch(async (error) => {
        if (!(error instanceof Error) || !error.message.startsWith("corpusd returned 404")) throw error;
        await this.socket.request("POST", "/v0/corpus", { uri: this.manifestUri(snapshot.uri ?? snapshot.ref, snapshot.id) }, options);
        await this.info(snapshot.id, options);
      });
      this.attachedCache.set(snapshot.id, snapshot);
      this.attachedCache.set(snapshot.ref, snapshot);
      return snapshot;
    })();

    this.attachingCache.set(snapshot.id, promise);
    try {
      return await promise;
    } finally {
      this.attachingCache.delete(snapshot.id);
    }
  }

  async search(refOrId: string, query: string, k = 5, options?: RequestOptions): Promise<CorpusSearchHit[]> {
    const parsed = await this.socket.request("QUERY", `/v0/corpus/${encodeURIComponent(refOrId)}`, { q: query, k }, options) as { hits?: CorpusSearchHit[] };
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
