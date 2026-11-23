import type { gateway } from "ai";

// Leave room for Jev's framing; cap serialized JSON batch at 24 KiB on retry.
const JEV_BATCH_BYTES = 24 * 1024;

type Evidence = { name: string; input: unknown; output: unknown };
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const record = (value: unknown) =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const short = (value: unknown) =>
  typeof value === "string" && Buffer.byteLength(value) <= 1024 ? value : undefined;

function excerpt(call: Evidence, sources: Map<string, string>, limit: number) {
  const input = record(call.input);
  const output = record(call.output);
  const path = short(input.path) ?? short(output.path) ?? short(output.filePath);
  const url = short(output.url) ?? short(input.url) ?? (path && sources.get(path));
  const text =
    typeof output.content === "string"
      ? output.content
      : typeof call.output === "string"
        ? call.output
        : JSON.stringify(call.output);
  const fragment = {
    name: call.name,
    input: { ...(path && { path }), ...(url && { url }) },
    output: { excerpt: "", truncated: true },
  };
  if (byteSize(fragment) > limit) return;
  let low = 0;
  let high = Math.min(text.length, limit) + 1;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    fragment.output.excerpt = text.slice(0, mid);
    if (byteSize(fragment) <= limit) low = mid;
    else high = mid;
  }
  fragment.output.excerpt = text.slice(0, low).replace(/[\uD800-\uDBFF]$/, "");
  return fragment;
}

export function fitJevEvidence(state: object, questions: object, evidence: Evidence[]) {
  const batch = { state, questions };
  if (!evidence.length || byteSize(batch) > JEV_BATCH_BYTES) return evidence;
  const withEvidence = (value: Evidence[]) => ({ ...batch, state: { ...state, evidence: value } });
  if (byteSize(withEvidence(evidence)) <= JEV_BATCH_BYTES) return evidence;
  const sizes = evidence.map(byteSize);
  let available = JEV_BATCH_BYTES - byteSize(withEvidence([])) - evidence.length;
  let remaining = evidence.length;
  for (const size of [...sizes].sort((a, b) => a - b)) {
    if (size > available / remaining) break;
    available -= size;
    remaining--;
  }
  const limit = Math.floor(available / remaining);
  const sources = new Map<string, string>();
  for (const call of evidence) {
    const output = record(call.output);
    const file = short(output.filePath);
    const url = short(output.url);
    if (file && url) sources.set(file, url);
  }
  return evidence.flatMap((call, index) => {
    if (sizes[index]! <= limit) return [call];
    const truncated = excerpt(call, sources, limit);
    return truncated ? [truncated] : [];
  });
}

type DecisionModel = ReturnType<typeof gateway.decisionModel>;
type StatePart = Parameters<DecisionModel["doDecide"]>[0]["state"][number];
type JsonState = Extract<StatePart, { type: "json" }>["value"];

export function isDecisionModel(model: unknown): model is DecisionModel {
  const value = record(model);
  return (
    value.specificationVersion === "v4" &&
    typeof value.doDecide === "function" &&
    Array.isArray(value.supportedQuestionTypes)
  );
}

function isTokenOverflow(error: unknown) {
  function matches(body: unknown) {
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return false;
      }
    }
    const value = record(body);
    return (
      value.error_type === "max_tokens_exceeded" ||
      record(value.error).error_type === "max_tokens_exceeded"
    );
  }
  const failure = record(error);
  const cause = record(failure.cause);
  return [failure.response, failure.responseBody, failure.message, cause.responseBody].some(matches);
}

export function retryJevWithExcerpts(model: DecisionModel, state: JsonState) {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedQuestionTypes: model.supportedQuestionTypes,
    async doDecide(options) {
      try {
        return await model.doDecide(options);
      } catch (error) {
        if (!isTokenOverflow(error)) throw error;
        options.abortSignal?.throwIfAborted();
        console.info("[eve-qa] Jev rejected the evidence volume. Retrying with bounded excerpts.");
        return await model.doDecide({ ...options, state: [{ type: "json", value: state }] });
      }
    },
  } satisfies DecisionModel;
}
