// Eve registers its bundled API globally. A newer external API cannot read an
// older registration, so capture context through the same API Eve uses.
import { context, propagation, trace } from "../../node_modules/eve/dist/src/compiled/@opentelemetry/api/index.js";
import type { RequestOptions } from "../lib/corpus-mcp";

export function activeTraceContext(): RequestOptions["traceContext"] {
  if (!trace.getActiveSpan()) return undefined;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, {
    set(target, key, value) { target[key] = value; },
  });
  const { traceparent, tracestate } = carrier;
  if (!traceparent) return undefined;
  return { traceparent, ...(tracestate ? { tracestate } : {}) };
}
