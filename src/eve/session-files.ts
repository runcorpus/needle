import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface SessionIdentity {
  id: string;
  parent?: { rootSessionId: string };
}

export function questionDirectory(root: string, session: SessionIdentity) {
  return join(root, encodeURIComponent(session.parent?.rootSessionId ?? session.id));
}

export async function writeRecord(directory: string, name: string, value: unknown) {
  await mkdir(directory, { recursive: true });
  const pending = join(directory, `${randomUUID()}.tmp`);
  await writeFile(pending, JSON.stringify(value));
  await rename(pending, join(directory, `${encodeURIComponent(name)}.json`));
}

export async function readRecords<T>(directory: string): Promise<T[]> {
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(files.filter((name) => name.endsWith(".json")).sort().map(async (name) =>
    JSON.parse(await readFile(join(directory, name), "utf8")) as T,
  ));
}
