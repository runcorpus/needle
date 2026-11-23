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
      ...(backend === "vercel" ? [gatewayWarningMiddleware] : []),
    ],
  });
}
