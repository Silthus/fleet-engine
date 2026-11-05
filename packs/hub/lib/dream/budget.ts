import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export const memoryLimits = { indexLines: 180, indexBytes: 24_000, files: 150, fileLines: 80, fileBytes: 6000, totalBytes: 200_000, staleDays: 60 };
export const notMemory = new Set([".git", "dreams", "node_modules"]);
export type Problem = { file: string; problem: string };

export function markdownFiles(root: string, depth = 6): string[] {
  if (!existsSync(root) || depth < 0) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return notMemory.has(entry.name) ? [] : markdownFiles(path, depth - 1);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

export const isIndex = (file: string) => basename(file) === "MEMORY.md" || basename(file) === "INDEX.md";

export function budget(memory: string, usage: Record<string, string>, now: number): Problem[] {
  const problems: Problem[] = [];
  if (!existsSync(join(memory, "MEMORY.md"))) return [{ file: "MEMORY.md", problem: "missing" }];
  const files = markdownFiles(memory).map((path) => relative(memory, path));
  const indexes = files.filter(isIndex);
  const memories = files.filter((file) => !isIndex(file) && file !== "README.md");
  const linked = new Set<string>();
  for (const index of indexes) {
    const text = readFileSync(join(memory, index), "utf8");
    if (index === "MEMORY.md" && text.split("\n").length > memoryLimits.indexLines) problems.push({ file: index, problem: `${text.split("\n").length} lines; the limit is ${memoryLimits.indexLines}` });
    if (index === "MEMORY.md" && Buffer.byteLength(text) > memoryLimits.indexBytes) problems.push({ file: index, problem: `${Buffer.byteLength(text)} bytes; the limit is ${memoryLimits.indexBytes}. Shorten its lines or move a section into an INDEX.md` });
    for (const match of text.matchAll(/\]\(([^)#\s]+\.md)\)/g)) {
      const target = relative(memory, resolve(join(memory, index, ".."), match[1]!));
      linked.add(target);
      if (!existsSync(join(memory, target))) problems.push({ file: index, problem: `links ${match[1]}, which does not exist` });
    }
  }
  let total = 0;
  for (const file of memories) {
    const text = readFileSync(join(memory, file), "utf8");
    const bytes = Buffer.byteLength(text);
    total += bytes;
    if (!linked.has(file)) problems.push({ file, problem: "no index links it" });
    const lineCount = text.split("\n").length;
    if (lineCount > memoryLimits.fileLines || bytes > memoryLimits.fileBytes) problems.push({ file, problem: `${lineCount} lines, ${bytes} bytes; condense it below ${memoryLimits.fileLines} lines and ${memoryLimits.fileBytes} bytes` });
    for (const field of ["name", "description", "type"]) if (!new RegExp(`^\\s*${field}:`, "m").test(text)) problems.push({ file, problem: `frontmatter has no ${field}` });
    const touched = ["modified", "verified"].map((field) => Date.parse(new RegExp(`^\\s*${field}:\\s*"?([^"\\n]+)`, "m").exec(text)?.[1] ?? "")).filter((at) => !Number.isNaN(at));
    const last = Math.max(0, ...touched, Date.parse(usage[file] ?? "") || 0);
    if (last && now - last > memoryLimits.staleDays * 86_400_000) problems.push({ file, problem: `stale: not written, verified, or read since ${new Date(last).toISOString().slice(0, 10)}; delete it or set verified after checking it` });
  }
  if (memories.length > memoryLimits.files) problems.push({ file: ".", problem: `${memories.length} memories; the limit is ${memoryLimits.files}. Merge or delete some` });
  if (total > memoryLimits.totalBytes) problems.push({ file: ".", problem: `${total} bytes; the limit is ${memoryLimits.totalBytes}. Condense or delete some` });
  return problems;
}
