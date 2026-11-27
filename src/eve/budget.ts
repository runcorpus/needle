import { wrapLanguageModel } from "ai";
import { defineState } from "eve/context";
import { runs, usage } from "eve/events";
import { defineDynamic, type ModelSelection } from "eve/models";

export const INPUT_BUDGET = 200_000;
export const OUTPUT_BUDGET = 32_768;
export const RESEARCH_OUTPUT_TOKENS = 4096;
const FINAL_OUTPUT_TOKENS = 16_384;

const FINISH = `Your budget is nearly exhausted. Verify candidates and finish using the evidence already collected. You may fetch already-retrieved URLs and inspect saved sources, but stop discovery and new searches.
Follow the required output format. Complete the current decision tool: select_collections with [] during discovery, or record_ranking using available candidates with no recovery.`;
const finalTools = new Set(["bash", "write_file", "edit_file", "select_collections", "record_ranking", "web_fetch", "read_document", "grep", "read_file"]);

type Model = Parameters<typeof wrapLanguageModel>[0]["model"];
type Spent = { inputTokens: number; outputTokens: number };
const finishing = defineState("corpus-needle-eval.finishing", () => false);

export function isFinalizing() {
  return finishing.get();
}

export function budgetApproval({ toolName }: { toolName?: string; toolInput?: Record<string, unknown> } = {}) {
  const canFinish = finalTools.has(toolName ?? "");
  return finishing.get() && !canFinish ? { type: "denied" as const, reason: FINISH } : undefined;
}

export function budgetedModel(model: Model, options: Omit<ModelSelection, "model"> = {}) {
  return defineDynamic((ctx) => ({
    ...options,
    model: withAnswerReserve(
      model,
      usage(ctx.view).total,
      runs(ctx.view).filter((run) => run.usage).at(-1)?.usage?.inputTokens ?? 0,
    ),
  }));
}

export function withAnswerReserve(model: Model, spent: Spent, lastInputTokens: number) {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      async transformParams({ params }) {
        if (!params.tools?.length) return params;
        const remaining = OUTPUT_BUDGET - spent.outputTokens;
        if (remaining <= 0) throw new Error("Corpus eval output budget exhausted.");
        const estimatedInput = Math.max(
          lastInputTokens,
          Math.ceil(
            (JSON.stringify(params.prompt).length + JSON.stringify(params.tools).length) / 3,
          ),
        );
        const inputPerCall = Math.ceil(estimatedInput * 1.2) + 1024;
        if (
          !finishing.get() &&
          spent.inputTokens + 4 * inputPerCall < INPUT_BUDGET &&
          remaining >= RESEARCH_OUTPUT_TOKENS + FINAL_OUTPUT_TOKENS
        ) {
          return { ...params, maxOutputTokens: RESEARCH_OUTPUT_TOKENS };
        }

        finishing.update(() => true);
        console.info(
          `[eve-qa] Finishing: ${spent.inputTokens} input tokens used; reserving ~${inputPerCall} for the answer.`,
        );
        return {
          ...params,
          maxOutputTokens: Math.min(remaining, FINAL_OUTPUT_TOKENS),
          prompt: [...params.prompt, { role: "user", content: [{ type: "text", text: FINISH }] }],
        };
      },
    },
  });
}
