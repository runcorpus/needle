import type { SandboxRunOptions } from "eve/sandbox";
import { defineTool } from "eve/tools";
import grep from "eve/tools/grep";
import { runSandboxCommand } from "./bash";

export function boundedGrep(timeout: number) {
  return defineTool({
    description: grep.description,
    inputSchema: grep.inputSchema,
    outputSchema: grep.outputSchema,
    toModelOutput: grep.toModelOutput,
    execute(input, context) {
      return grep.execute(input, {
        ...context,
        async getSandbox() {
          const sandbox = await context.getSandbox();
          return {
            ...sandbox,
            async run(options: SandboxRunOptions) {
              const signal = options.signal
                ? AbortSignal.any([options.signal, context.abortSignal])
                : context.abortSignal;
              const result = await runSandboxCommand(
                () => Promise.resolve(sandbox),
                { ...options, signal },
                timeout,
                1024 * 1024,
              );
              if (result.truncated) {
                throw new Error("Sandbox grep exceeded its command output limit.");
              }
              return result;
            },
          };
        },
      });
    },
  });
}

export default boundedGrep(30);
