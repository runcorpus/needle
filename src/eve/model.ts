import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { gateway, wrapLanguageModel, type CallWarning, type LanguageModelMiddleware } from "ai";
import { RESEARCH_OUTPUT_TOKENS } from "./budget";

export const DEFAULT_AGENT_MODEL = "deepseek/deepseek-v4.1-flash-1017";

// TODO: Remove this filter and its regression test when AI Gateway stops
// returning the token-pass deprecation for requests that omit the option.
function keepGatewayWarning(warning: CallWarning) {
  return !(
    warning.type === "deprecated" &&
    warning.setting === "providerOptions key 'token-pass'" &&
    warning.message === "Use 'tokenPass' instead."
  );
}

const gatewayWarningMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  async wrapGenerate({ doGenerate }) {
    const result = await doGenerate();
    return { ...result, warnings: result.warnings.filter(keepGatewayWarning) };
  },
  async wrapStream({ doStream }) {
    const result = await doStream();
    return {
      ...result,
      stream: result.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          controller.enqueue(part.type === "stream-start"
            ? { ...part, warnings: part.warnings.filter(keepGatewayWarning) }
            : part);
        },
      })),
    };
  },
};

export function modelStreamIdleTimeout(idleMs = 60_000): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    async wrapStream({ model, params }) {
      const controller = new AbortController();
      const signal = params.abortSignal
        ? AbortSignal.any([params.abortSignal, controller.signal]) : controller.signal;
      let timer: ReturnType<typeof setTimeout>;
      let requestId: string | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          console.warn("[model-stream] Aborting idle request", { model: model.modelId, requestId, idleMs });
          controller.abort(new DOMException(`Model stream produced no data for ${idleMs}ms.`, "TimeoutError"));
        }, idleMs);
      };
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => rejectAbort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
      arm();
      try {
        const result = await Promise.race([model.doStream({ ...params, abortSignal: signal }), aborted]);
        requestId = result.response?.headers?.["x-vercel-id"];
        const reader = result.stream.getReader();
        return {
          ...result,
          stream: new ReadableStream({
            async pull(output) {
              try {
                const next = await Promise.race([reader.read(), aborted]);
                if (next.done) { cleanup(); output.close(); }
                else { arm(); output.enqueue(next.value); }
              } catch (error) {
                cleanup();
                void reader.cancel(error).catch(() => {});
                output.error(error);
              }
            },
            cancel(reason) {
              cleanup();
              controller.abort(reason);
              return reader.cancel(reason);
            },
          }),
        };
      } catch (error) {
        cleanup();
        throw error;
      }
    },
  };
}

export function modelSettings(
  stage: "answer" | "judge",
  gatewayModel = DEFAULT_AGENT_MODEL,
) {
  const solverBackend = process.env.AGENT_PROVIDER || "vercel";
  const backend =
    (stage === "judge" && process.env.JUDGE_PROVIDER) || solverBackend;
  if (backend !== "vercel" && backend !== "ollama") {
    throw new Error("Corpus evals support vercel or ollama.");
  }
  const model =
    (stage === "judge" && process.env.JUDGE_MODEL) ||
    ((stage === "answer" || backend === solverBackend) &&
      process.env.AGENT_MODEL) ||
    (backend === "vercel" ? gatewayModel : "qwen3:8b");
  const baseURL =
    (stage === "judge" && process.env.JUDGE_BASE_URL) ||
    (backend === "ollama"
      ? process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"
      : undefined);
  return { backend, model, baseURL };
}

export function languageModel(stage: "answer" | "judge", gatewayModel?: string) {
  const { backend, model, baseURL } = modelSettings(stage, gatewayModel);
  const configured =
    backend === "ollama"
      ? createOpenAICompatible({
          name: "ollama",
          baseURL: `${baseURL!.replace(/\/+$/, "")}/v1`,
          includeUsage: true,
        })(model)
      : gateway.languageModel(model);
  return wrapLanguageModel({
    model: configured,
    middleware: [
      {
        specificationVersion: "v4",
        transformParams: async ({ params }) => ({
          ...params,
          temperature: 0,
          maxOutputTokens: params.maxOutputTokens ?? RESEARCH_OUTPUT_TOKENS,
        }),
      },
      ...(stage === "answer" ? [modelStreamIdleTimeout()] : []),
      ...(backend === "vercel" ? [gatewayWarningMiddleware] : []),
    ],
  });
}
