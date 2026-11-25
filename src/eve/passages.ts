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

export async function findFetchedPassage(
  directory: string,
  sandbox: Pick<SandboxSession, "readBinaryFile">,
  url: string,
  snippet: string,
  signal: AbortSignal,
): Promise<SnippetSource | undefined> {
  for (const file of await readRecords<FetchedFile>(join(directory, "fetched"))) {
    if (file.url !== url || !file.totalLines) continue;
    const bytes = await sandbox.readBinaryFile({ path: file.path, signal });
    if (!bytes || digest(bytes) !== file.digest) continue;
    const text = new TextDecoder().decode(bytes);
    const offset = text.indexOf(snippet);
    if (offset < 0) continue;
    const startLine = text.slice(0, offset).split(/\r\n|\r|\n/).length;
    const endLine = startLine + snippet.trimEnd().split(/\r\n|\r|\n/).length - 1;
    return { type: "web_fetch", startLine, endLine };
  }
}
