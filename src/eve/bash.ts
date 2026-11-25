import type { SandboxProcess, SandboxSession, SandboxSpawnOptions } from "eve/sandbox";
import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

const OUTPUT_LIMIT = 16 * 1024;

async function readOutput(stream: ReadableStream<Uint8Array>, signal: AbortSignal, limit: number) {
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  const buffer = new Uint8Array(limit);
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, limit - size);
      buffer.set(chunk, size);
      size += chunk.length;
      truncated ||= chunk.length < value.length;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(buffer.subarray(0, size)), truncated };
}

export async function runSandboxCommand(
  getSandbox: () => PromiseLike<Pick<SandboxSession, "spawn">>,
  { signal: parent, ...options }: SandboxSpawnOptions,
  timeout: number,
  outputLimit = OUTPUT_LIMIT,
) {
  const deadline = AbortSignal.timeout(Math.ceil(timeout * 1000));
  const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
  let running: SandboxProcess | undefined;
  const cancel = (process: SandboxProcess) => {
    // A stuck provider must not delay returning the tool failure to the agent.
    void Promise.resolve().then(() => process.kill()).catch(() => {});
  };
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      if (running) cancel(running);
      reject(parent?.aborted
        ? parent.reason
        : new Error(`Sandbox command exceeded its ${timeout}s deadline.`));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const execute = async () => {
    signal.throwIfAborted();
    const sandbox = await getSandbox();
    signal.throwIfAborted();
    running = await sandbox.spawn({ ...options, signal });
    if (signal.aborted) {
      cancel(running);
      signal.throwIfAborted();
    }
    const [out, err, { exitCode }] = await Promise.all([
      readOutput(running.stdout, signal, outputLimit),
      readOutput(running.stderr, signal, outputLimit),
      running.wait(),
    ]);
    return {
      status: "completed" as const, exitCode,
      stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated,
    };
  };
  try {
    return await Promise.race([aborted, execute()]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export default defineTool({
  description: "Run a foreground shell command in the sandbox. The command stops at its deadline.",
  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().positive().max(120).default(60).describe("Deadline in seconds. Defaults to 60."),
  }),
  execute({ command, timeout }, context) {
    return runSandboxCommand(() => context.getSandbox(), { command, signal: context.abortSignal }, timeout);
  },
  toModelOutput({ stdout, stderr, exitCode, truncated }) {
    const text = [stdout, stderr, truncated ? "(output truncated)" : ""].filter(Boolean).join("\n");
    return exitCode === 0 ? toolOutput.text(text || "(no output)") : toolOutput.errorText(`${text}\n[exit code: ${exitCode}]`);
  },
});
