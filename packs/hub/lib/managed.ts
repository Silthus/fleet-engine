import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { refuseLinks, writePrivateFile } from "./mcphub/client.ts";

export type Managed = { path: string; content: string };

export const readIfThere = (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });

export async function changedFiles(home: string, files: Managed[], marker: string, what: string): Promise<Managed[]> {
  const changed: Managed[] = [];
  for (const file of files) {
    await refuseLinks(home, file.path, `${what} path`);
    const existing = await readIfThere(file.path);
    if (existing !== undefined && !existing.includes(marker)) throw new Error(`Keep unmanaged ${what} file: ${file.path}`);
    if (existing !== file.content) changed.push(file);
  }
  return changed;
}

export async function writeFiles(files: Managed[]): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writePrivateFile(file.path, file.content);
  }
}
