import { createHash } from "node:crypto";
import { z } from "zod";
import { CorpusMcp, type RequestOptions } from "./corpus-mcp";
import type { CorpusSearchHit, CorpusSnapshotRef, DiscoveryIndexHit } from "./types";

const infoResult = z.object({ snapshot: z.string().regex(/^[a-f0-9]{64}$/), documents: z.number().int().nonnegative() });
const searchResult = z.object({ hits: z.array(z.object({ urn: z.string(), url: z.string(), score: z.number(),
  meta: z.looseObject({ title: z.string(), description: z.string() }) })) });

function pinnedReference(snapshot: CorpusSnapshotRef) {
  return `${snapshot.ref.replace(/:[^:]+$/, "")}@sha256:${snapshot.id}`;
}

export class CorpusClient {
  private readonly registry: string;
  private readonly attachedCache = new Map<string, CorpusSnapshotRef>();
  private readonly attachingCache = new Map<string, Promise<CorpusSnapshotRef>>();
  private readonly mcp = new CorpusMcp();

  constructor(registry = "https://library.runcorpus.com", indexSnapshot?: CorpusSnapshotRef) {
    this.registry = registry.replace(/\/+$/, "");
    if (indexSnapshot) this.remember(indexSnapshot);
  }

  private remember(snapshot: CorpusSnapshotRef) {
    this.attachedCache.set(snapshot.ref, snapshot);
    this.attachedCache.set(snapshot.id, snapshot);
    return snapshot;
  }

  // Historical artifact field cliVersion now records the remote MCP server version.
  async version(): Promise<string> { return this.mcp.version(); }

  async resolveLatestTag(corpusSlug: string): Promise<string> {
    if (corpusSlug.includes(":")) return corpusSlug;
    const response = await fetch(`${this.registry}/${corpusSlug}/tags`);
    if (!response.ok) throw new Error(`Failed to list tags for ${corpusSlug} (${response.status}).`);
    const { tags } = await response.json() as { tags: string[] };
    if (!tags?.length) throw new Error(`No published tags found for ${corpusSlug}.`);
    return `${corpusSlug}:${tags.includes("latest") ? "latest" : [...tags].sort().at(-1)}`;
  }

  async attachAndInfo(refOrSlug: string, options?: RequestOptions): Promise<CorpusSnapshotRef> {
    const qualified = await this.resolveLatestTag(refOrSlug);
    const cached = this.attachedCache.get(qualified);
    if (cached) return cached;
    const pending = this.attachingCache.get(qualified);
    if (pending) return pending;
    const promise = (async () => {
      const metadata = infoResult.parse(await this.mcp.callTool("info", { corpus: qualified }, options));
      const resource = qualified.replace(/:[^:]+$/, "");
      const path = resource.includes("/") ? resource : `_/${resource}`;
      const uri = `${this.registry}/${path}/sha256/${metadata.snapshot}`;
      // MCP info does not expose labels. Read them from the verified public manifest.
      const response = await fetch(uri, { signal: options?.signal, redirect: "error" });
      if (!response.ok) throw new Error(`Cannot read the Library manifest (${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== metadata.snapshot) throw new Error("Library snapshot digest mismatch.");
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { labels?: Record<string, string> };
      return this.remember({ ref: qualified, tag: qualified.slice(qualified.lastIndexOf(":") + 1), id: metadata.snapshot,
        uri, documents: metadata.documents, labels: manifest.labels ?? {} });
    })();
    this.attachingCache.set(qualified, promise);
    try { return await promise; }
    finally { this.attachingCache.delete(qualified); }
  }

  async attachPinned(snapshot: CorpusSnapshotRef, options?: RequestOptions): Promise<CorpusSnapshotRef> {
    if (this.attachedCache.has(snapshot.id)) return this.remember(snapshot);
    const pending = this.attachingCache.get(snapshot.id);
    if (pending) return pending;
    const promise = (async () => {
      const metadata = infoResult.parse(await this.mcp.callTool("info", { corpus: pinnedReference(snapshot) }, options));
      if (metadata.snapshot !== snapshot.id) throw new Error("MCP returned a different pinned Library snapshot.");
      return this.remember(snapshot);
    })();
    this.attachingCache.set(snapshot.id, promise);
    try { return await promise; }
    finally { this.attachingCache.delete(snapshot.id); }
  }

  async search(refOrId: string, query: string, k = 5, options?: RequestOptions): Promise<CorpusSearchHit[]> {
    const snapshot = this.attachedCache.get(refOrId);
    if (!snapshot) throw new Error(`Corpus ${refOrId} has not been attached.`);
    return searchResult.parse(await this.mcp.callTool("search", {
      corpus: pinnedReference(snapshot), query, k,
    }, options)).hits;
  }

  async searchIndex(indexRef: string, query: string, k = 5): Promise<DiscoveryIndexHit[]> {
    return (await this.search(indexRef, query, k)).map((hit) => {
      const corpus = typeof hit.meta.corpus === "string" ? hit.meta.corpus
        : hit.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/+$/, "");
      return { corpus, title: hit.meta.title ?? corpus, description: hit.meta.description ?? "", score: hit.score };
    }).filter((hit) => hit.corpus && hit.corpus !== "_/index");
  }
}
