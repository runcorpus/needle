import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { Context, ContextManager, TextMapPropagator } from "@opentelemetry/api";
import { writeRecord } from "./session-files";
import { activeTraceContext } from "./trace-context";
import { SocketClient } from "../lib/corpus-socket";
import { createNeedleRetrievalAgent } from "./needle-retrieval";

const storage = new AsyncLocalStorage<Context>();
const eveApi = join(dirname(fileURLToPath(import.meta.resolve("eve"))), "compiled/@opentelemetry/api/index.js");
// Eve's declarations expose only a subset of the bundled API's runtime methods.
const { context, propagation, ROOT_CONTEXT, trace }: typeof import("@opentelemetry/api") = await import(pathToFileURL(eveApi).href);

beforeAll(() => {
  const manager: ContextManager = {
    active: () => storage.getStore() ?? ROOT_CONTEXT,
    with: (active, fn, thisArg, ...args) => storage.run(active, () => fn.apply(thisArg, args)),
    bind: (_active, target) => target,
    enable() { return this; },
    disable() { storage.disable(); return this; },
  };
  const propagator: TextMapPropagator = {
    inject(active, carrier, setter) {
      const span = trace.getSpan(active)?.spanContext();
      if (span) setter.set(carrier, "traceparent", `00-${span.traceId}-${span.spanId}-${span.traceFlags.toString(16).padStart(2, "0")}`);
    },
    extract: (active) => active,
    fields: () => ["traceparent"],
  };
  context.setGlobalContextManager(manager);
  propagation.setGlobalPropagator(propagator);
});

afterAll(() => {
  context.disable();
  propagation.disable();
});

test("reads Eve's bundled active span and isolates concurrent search traces", async () => {
  const eveApi = join(dirname(fileURLToPath(import.meta.resolve("eve"))), "compiled/@opentelemetry/api/index.js");
  const otel = await import(pathToFileURL(eveApi).href);
  const capture = (spanId: string) => otel.context.with(
    otel.trace.setSpan(otel.context.active(), {
      spanContext: () => ({ traceId: "0123456789abcdef0123456789abcdef", spanId, traceFlags: 1 }),
    }),
    async () => { await Promise.resolve(); return activeTraceContext(); },
  );
  const [first, second] = await Promise.all([capture("1111111111111111"), capture("2222222222222222")]);
  expect(first?.traceparent).toBe("00-0123456789abcdef0123456789abcdef-1111111111111111-01");
  expect(second?.traceparent).toBe("00-0123456789abcdef0123456789abcdef-2222222222222222-01");
  expect(activeTraceContext()).toBeUndefined();
});

test("corpus search forwards the active tool span and cancellation to SocketClient", async () => {
  const root = await mkdtemp(join(tmpdir(), "needle-traces-"));
  const request = spyOn(SocketClient.prototype, "request").mockResolvedValue({ hits: [] });
  const signal = new AbortController().signal;
  const traceId = "0123456789abcdef0123456789abcdef";
  const spanId = "1111111111111111";
  try {
    await writeRecord(join(root, "question"), "phase", "discover");
    const harness = createNeedleRetrievalAgent({
      indexSnapshot: { ref: "_/index:latest", id: "index", uri: null, tag: null, documents: 1, labels: {} },
      registry: "https://example.com", agentModel: "test/model", zeroDataRetention: true,
      k: 5, snippetChars: 2000, sessionDir: root,
    });
    await context.with(trace.setSpanContext(context.active(), { traceId, spanId, traceFlags: 1 }), () =>
      harness.corpusSearch.execute({ corpus: "_/index:latest", q: "regulations", k: 5 }, {
        session: { id: "question" }, callId: "search", abortSignal: signal,
      } as never),
    );
    expect(request.mock.calls[0]).toEqual([
      "QUERY", "/v0/corpus/index", { q: "regulations", k: 5 },
      { signal, traceContext: { traceparent: `00-${traceId}-${spanId}-01` } },
    ]);
  } finally {
    request.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
