import { wrapLanguageModel } from "ai";
import { defineState } from "eve/context";
import { runs, usage } from "eve/events";
import { defineDynamic, type ModelSelection } from "eve/models";

export const INPUT_BUDGET = 200_000;
export const OUTPUT_BUDGET = 32_768;
export const RESEARCH_OUTPUT_TOKENS = 4096;
const FINAL_OUTPUT_TOKENS = 16_384;

const FINISH = `Your budget is nearly exhausted. Finish now using the evidence already collected.
Follow the required output format.
Do not make further tool calls.`;

type Model = Parameters<typeof wrapLanguageModel>[0]["model"];
type Spent = { inputTokens: number; outputTokens: number };
const finishing = defineState("corpus-needle-eval.finishing", () => false);

export function budgetApproval() {
  return finishing.get() ? { type: "denied" as const, reason: FINISH } : undefined;
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
          spent.inputTokens + 2 * inputPerCall < INPUT_BUDGET &&
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
