import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SandboxSession } from "eve/sandbox";
import type { SnippetSource } from "../lib/types";
import { readRecords, writeRecord } from "./session-files";

interface FetchedFile {
  path: string;
  url: string;
  totalLines: number;
  digest: string;
}

function digest(content: string | Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

export async function recordFetchedFile(directory: string, filePath: string, url: string, content: string | Uint8Array, totalLines = 0) {
  await writeRecord(join(directory, "fetched"), filePath, { path: filePath, url, totalLines, digest: digest(content) });
}

export async function recordExtractedFile(directory: string, sourcePath: string, filePath: string, bytes: Uint8Array, text: string, totalLines: number) {
  const source = (await readRecords<FetchedFile>(join(directory, "fetched"))).find(({ path }) => path === sourcePath);
  if (source && digest(bytes) === source.digest) await recordFetchedFile(directory, filePath, source.url, text, totalLines);
}

export async function* fetchedPages(
  directory: string, sandbox: Pick<SandboxSession, "readBinaryFile">, url: string, signal: AbortSignal,
) {
  for (const file of await readRecords<FetchedFile>(join(directory, "fetched"))) {
    if (file.url !== url || !file.totalLines) continue;
    const bytes = await sandbox.readBinaryFile({ path: file.path, signal });
    if (bytes && digest(bytes) === file.digest) yield new TextDecoder().decode(bytes);
  }
}

export function passageSource(text: string, snippet: string): SnippetSource | undefined {
  const offset = text.indexOf(snippet);
  if (offset < 0) return;
  const startLine = text.slice(0, offset).split(/\r\n|\r|\n/).length;
  const endLine = startLine + snippet.trimEnd().split(/\r\n|\r|\n/).length - 1;
  return { type: "web_fetch", startLine, endLine };
}

export async function findFetchedPassage(
  directory: string, sandbox: Pick<SandboxSession, "readBinaryFile">,
  url: string, snippet: string, signal: AbortSignal,
): Promise<SnippetSource | undefined> {
  for await (const text of fetchedPages(directory, sandbox, url, signal)) {
    const source = passageSource(text, snippet);
    if (source) return source;
  }
}

export const clippedEnding = /(?:…|\.\.\.)$/;

// Preserve the indexed opening. A short feed label ending in a colon can be
// absent on the page, but dropping part of the article can lose its subject.
export function completeClippedSnippet(description: string, page: string, limit: number): string | undefined {
  if (!clippedEnding.test(description) || description.length >= limit) return;
  const excerpt = description.replace(clippedEnding, "").trim();
  const withoutLabel = excerpt.replace(/^(?:(?![.!?]\s)[^\n]){1,64}:\s+/, "");
  for (const opening of new Set([excerpt, withoutLabel])) {
    const words = opening.split(/\s+/);
    if (words.length < 8) continue;
    const escaped = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(escaped.join("\\s+"), "gu");
    const match = pattern.exec(page);
    if (!match || pattern.exec(page)) continue;
    const end = match.index + match[0].length;
    const tail = page.slice(end, match.index + limit);
    const boundary = tail.search(/\n\s*\n/);
    const continuation = (boundary < 0 ? tail : tail.slice(0, boundary)).trimEnd();
    if (continuation.trim().length >= 32) return match[0] + continuation;
  }
}
