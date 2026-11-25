import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { publicRunJson } from "../src/lib/public-run-json";

async function copyTraces(source: string, destination: string) {
  const entries = await readdir(source, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const input = join(source, entry.name);
    const output = join(destination, entry.name);
    if (entry.isDirectory()) await copyTraces(input, output);
    else if (entry.isFile() && /\.json(?:l(?:\.\d+)?)?$/.test(entry.name)) {
      const text = await readFile(input, "utf8");
      const rows = entry.name.endsWith(".json") ? [text] : text.split("\n").filter(Boolean);
      const redacted = rows.flatMap((row) => {
        try { return [publicRunJson(JSON.parse(row))]; }
        catch { console.warn(`[traces] Skipping an incomplete record in ${input}.`); return []; }
      });
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `${redacted.join("\n")}\n`);
    }
  }
}

const destination = process.argv[2];
if (!destination) throw new Error("Usage: bun scripts/trace-artifact.ts <destination>");
await copyTraces(".evals/traces", join(destination, "eve"));
await copyTraces(join(process.env.CORPUS_HOME ?? join(homedir(), ".corpus"), "traces"), join(destination, "corpusd"));
