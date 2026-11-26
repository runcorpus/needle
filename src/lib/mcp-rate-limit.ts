import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Shared by Bun, Eve's Node workers, both modes, and concurrent local runs.
// Requests proceed immediately unless a 429 response has started a shared cooldown.
export class McpRateLimiter {
  private readonly directory: string;
  constructor(endpoint: string) {
    this.directory = join(process.env.CORPUS_MCP_RATE_DIR ?? join(tmpdir(), "needle-mcp-rate-limit"),
      createHash("sha256").update(new URL(endpoint).origin).digest("hex"));
  }

  private async update<T>(change: (next: number) => [number, T], signal?: AbortSignal): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = join(this.directory, "lock");
    for (;;) {
      signal?.throwIfAborted();
      let lock;
      try { lock = await open(lockPath, "wx"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A killed worker must not leave all future benchmark runs locked out.
        try {
          const owner = Number(await readFile(lockPath, "utf8"));
          if (Number.isSafeInteger(owner) && owner > 0) {
            try { process.kill(owner, 0); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") await unlink(lockPath);
            }
          } else if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(25, undefined, { signal });
        continue;
      }
      try {
        await lock.writeFile(String(process.pid));
        const statePath = join(this.directory, "next");
        const stored = await readFile(statePath, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "0";
          throw error;
        });
        const next = Number(stored);
        if (!Number.isFinite(next)) throw new Error("Invalid MCP rate limiter state.");
        const [updated, result] = change(next);
        await writeFile(join(this.directory, "next.tmp"), String(updated));
        await rename(join(this.directory, "next.tmp"), statePath);
        return result;
      } finally {
        await lock.close();
        await unlink(lockPath);
      }
    }
  }

  async waitForCooldown(signal?: AbortSignal) {
    for (;;) {
      const wait = await this.update((next) => [next, Math.max(0, next - Date.now())], signal);
      if (!wait) return;
      await delay(wait, undefined, { signal });
    }
  }

  async backoff(milliseconds: number, signal?: AbortSignal) {
    await this.update((next) => [Math.max(next, Date.now() + milliseconds), undefined], signal);
  }
}
