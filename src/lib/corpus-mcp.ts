import { AsyncLocalStorage } from "node:async_hooks";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { z } from "zod";
import { McpRateLimiter } from "./mcp-rate-limit";

export interface RequestOptions {
  signal?: AbortSignal;
  traceContext?: { traceparent: string; tracestate?: string };
}

export const MCP_ENDPOINT = process.env.CORPUS_MCP_URL ?? "https://mcp.runcorpus.com/mcp";
const limiter = new McpRateLimiter(MCP_ENDPOINT);
const context = new AsyncLocalStorage<RequestOptions>();
let connection: Promise<MCPClient> | undefined;

async function limitedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const active = context.getStore();
  const signals = [init?.signal, active?.signal, AbortSignal.timeout(90_000)].filter((signal): signal is AbortSignal => !!signal);
  const signal = AbortSignal.any(signals);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const [key, value] of Object.entries(active?.traceContext ?? {})) if (value) headers.set(key, value);
  for (let attempt = 0; ; attempt++) {
    if (method.toUpperCase() === "POST") await limiter.acquire(signal);
    signal.throwIfAborted();
    const response = await fetch(input, { ...init, headers, signal });
    if (response.status !== 429) return response;
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const until = retryAfter === null ? NaN : Date.parse(retryAfter);
    const wait = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
      : Number.isFinite(until) ? Math.max(0, until - Date.now()) : 60_000 * 2 ** attempt;
    // Even the final failed request tells other processes to stop sending.
    await limiter.backoff(wait + Math.random() * 250, signal);
    if (attempt >= 3) return response;
    await response.body?.cancel();
    console.warn(`[corpus-mcp] HTTP 429; shared cooldown ${Math.ceil(wait / 1000)}s (retry ${attempt + 1}/3).`);
  }
}

async function client(): Promise<MCPClient> {
  if (connection) return connection;
  const pending = context.run({}, () => createMCPClient({
    clientName: "corpus-needle-benchmark",
    transport: { type: "http", url: MCP_ENDPOINT, fetch: Object.assign(limitedFetch, { preconnect: fetch.preconnect }) },
    initializationOptions: { timeout: 120_000 },
    maxRetries: 0, // All HTTP retries pass through the shared limiter above.
  }).catch((error) => { connection = undefined; throw error; }));
  connection = pending;
  return pending;
}

const toolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

export class CorpusMcp {
  async version() {
    const { serverInfo } = await client();
    return `${serverInfo.name} MCP ${serverInfo.version}`;
  }

  async callTool(name: "info" | "search", args: Record<string, unknown>, options: RequestOptions = {}) {
    options.signal?.throwIfAborted();
    const mcp = await client();
    options.signal?.throwIfAborted();
    const result = toolResult.parse(await context.run(options, () => mcp.callTool({ name, arguments: args,
      options: { signal: options.signal, timeout: 120_000 } })));
    if (result.isError) {
      throw new Error(result.content?.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("\n") || `MCP ${name} failed.`);
    }
    if (!result.structuredContent) throw new Error(`MCP ${name} returned no structured result.`);
    return result.structuredContent;
  }
}
