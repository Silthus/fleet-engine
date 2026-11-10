import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { minimumTerm, triggersOf } from "../../../memory/lib/triggers.ts";

export const memoryLimits = {
  indexLines: 180, indexBytes: 24_000, repoIndexLines: 100, repoIndexBytes: 12_000,
  files: 150, fileLines: 80, fileBytes: 6000, totalBytes: 200_000, staleDays: 60, unconfirmedDays: 14,
};
export const notMemory = new Set(["dreams", "node_modules"]);
export type Problem = { file: string; problem: string };
export type RepoCheckout = (repo: string) => string | undefined;

const day = 86_400_000;

export function markdownFiles(root: string, depth = 6): string[] {
  if (!existsSync(root) || depth < 0) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return notMemory.has(entry.name) || entry.name.startsWith(".") ? [] : markdownFiles(path, depth - 1);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

export const isIndex = (file: string) => basename(file) === "MEMORY.md" || basename(file) === "INDEX.md";

export function homeCheckouts(home: string): RepoCheckout {
  return (repo) => [join(home, "dev", repo), join(home, repo)].find((path) => existsSync(join(path, ".git")));
}

function field(text: string, name: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  return new RegExp(`^\\s*${name}:[ \\t]*"?([^"\\n]*)`, "m").exec(frontmatter)?.[1]?.trim() || undefined;
}

const namedPaths = (text: string) => [...new Set([...text.matchAll(/`([\w@.-]+(?:\/[\w@.-]+)+\.[a-z]{1,5})`/g)].map((match) => match[1]!).filter((path) => !path.includes("..")))];
const wikiLinks = (text: string) => [...new Set([...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((match) => match[1]!.trim()))];

function indexProblems(index: string, text: string): Problem[] {
  const main = index === "MEMORY.md";
  const [lineLimit, byteLimit] = main ? [memoryLimits.indexLines, memoryLimits.indexBytes] : [memoryLimits.repoIndexLines, memoryLimits.repoIndexBytes];
  const lines = text.split("\n").length;
  const bytes = Buffer.byteLength(text);
  const advice = main ? "Shorten its lines or move a section into an INDEX.md" : "Shorten its lines or move notes into topic notes";
  return [
    ...(lines > lineLimit ? [{ file: index, problem: `${lines} lines; the limit is ${lineLimit}` }] : []),
    ...(bytes > byteLimit ? [{ file: index, problem: `${bytes} bytes; the limit is ${byteLimit}. ${advice}` }] : []),
  ];
}

function noteProblems(file: string, text: string, names: Set<string>, now: number, checkouts: RepoCheckout): string[] {
  const problems: string[] = [];
  for (const name of wikiLinks(text)) if (!names.has(name)) problems.push(`links [[${name}]], which no memory is; repoint it, write that memory, or drop the link`);
  const status = field(text, "status");
  const modified = Date.parse(field(text, "modified") ?? "");
  if (status && status !== "confirmed" && status !== "unconfirmed") problems.push(`status ${status}; use confirmed or unconfirmed`);
  if (status === "unconfirmed" && modified && now - modified > memoryLimits.unconfirmedDays * day) problems.push(`unconfirmed since ${new Date(modified).toISOString().slice(0, 10)}; confirm it against a session or the code, or delete it`);
  for (const term of triggersOf(text)) if (term.length < minimumTerm) problems.push(`trigger "${term}" is shorter than ${minimumTerm} characters and never fires; name the command or tool`);
  const repo = /^projects\/([^/]+)\//.exec(file)?.[1];
  const checkout = repo ? checkouts(repo) : undefined;
  for (const path of checkout ? namedPaths(text) : []) {
    if (existsSync(join(checkout!, path.split("/")[0]!)) && !existsSync(join(checkout!, path))) problems.push(`names \`${path}\`, which the hub's ${repo} checkout lacks; check it, then fix or delete the memory`);
  }
  return problems;
}

export function budget(memory: string, usage: Record<string, string>, now: number, checkouts: RepoCheckout = () => undefined): Problem[] {
  const problems: Problem[] = [];
  if (!existsSync(join(memory, "MEMORY.md"))) return [{ file: "MEMORY.md", problem: "missing" }];
  const files = markdownFiles(memory).map((path) => relative(memory, path));
  const indexes = files.filter(isIndex);
  const memories = files.filter((file) => !isIndex(file) && file !== "README.md");
  const names = new Set(memories.map((file) => basename(file, ".md")));
  const linked = new Set<string>();
  for (const index of indexes) {
    const text = readFileSync(join(memory, index), "utf8");
    problems.push(...indexProblems(index, text));
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
    for (const name of ["name", "description", "type"]) if (!new RegExp(`^\\s*${name}:`, "m").test(text)) problems.push({ file, problem: `frontmatter has no ${name}` });
    problems.push(...noteProblems(file, text, names, now, checkouts).map((problem) => ({ file, problem })));
    const touched = ["modified", "verified"].map((name) => Date.parse(field(text, name) ?? "")).filter((at) => !Number.isNaN(at));
    const last = Math.max(0, ...touched, Date.parse(usage[file] ?? "") || 0);
    if (last && now - last > memoryLimits.staleDays * day) problems.push({ file, problem: `stale: not written, verified, or read since ${new Date(last).toISOString().slice(0, 10)}; delete it or set verified after checking it` });
  }
  const conflicts = join(memory, ".conflicts");
  for (const kept of existsSync(conflicts) ? readdirSync(conflicts) : []) {
    problems.push({ file: `.conflicts/${kept}`, problem: "a sync conflict replaced this version; merge what it has that the memory lacks, then delete it" });
  }
  if (memories.length > memoryLimits.files) problems.push({ file: ".", problem: `${memories.length} memories; the limit is ${memoryLimits.files}. Merge or delete some` });
  if (total > memoryLimits.totalBytes) problems.push({ file: ".", problem: `${total} bytes; the limit is ${memoryLimits.totalBytes}. Condense or delete some` });
  return problems;
}
