import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { refuseLinks, writePrivateFile } from "../../mcp-gateway/lib/client.ts";

export type Managed = { path: string; content: string };

export const readIfThere = (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });

export function ownedBy(content: string, marker: string): boolean {
  const [first, second] = content.split("\n", 2);
  return first === marker || (first?.startsWith("<?xml ") === true && first.endsWith("?>") && second === marker);
}

export async function readOwned(home: string, path: string, marker: string, what: string): Promise<string | undefined> {
  await refuseLinks(home, path, `${what} path`);
  const existing = await readIfThere(path);
  if (existing !== undefined && !ownedBy(existing, marker)) throw new Error(`Keep unmanaged ${what} file: ${path}`);
  return existing;
}

export async function changedFiles(home: string, files: Managed[], marker: string, what: string): Promise<Managed[]> {
  const changed: Managed[] = [];
  for (const file of files) if ((await readOwned(home, file.path, marker, what)) !== file.content) changed.push(file);
  return changed;
}

export async function writeFiles(files: Managed[]): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writePrivateFile(file.path, file.content);
  }
}

export async function requireInstalled(home: string, files: Managed[], marker: string, what: string, fix: string, stale: string[] = []): Promise<void> {
  const differing = [...(await changedFiles(home, files, marker, what)).map((file) => file.path), ...stale];
  if (differing.length) throw new Error(`These ${what} files differ from what install writes now: ${differing.join(", ")}. Run ${fix}.`);
}
