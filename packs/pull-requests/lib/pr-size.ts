import { isTestFile } from "./proof-delta.ts";

const usage = "Usage: fleet pr size --base <ref> [--lines <n>] [--concepts <n>]";
const generated = /\.lockb?$|-lock\.(json|yaml)$|(^|\/)go\.sum$/;
const authored = (path: string) => !isTestFile(path) && !generated.test(path);
const codeConcepts = [
  /(?:process\.env|Bun\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]+)/g,
  /(?:environ(?:\.get)?|getenv|ENV)[[(]\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /["'`](--[a-z][a-z0-9-]+)\b/g,
  /(?:[Ff]eature|[Ff]lag)\w*\(\s*["'`]([\w.-]+)["'`]/g,
];
const configKey = /^\s*["']?([A-Za-z_][\w.-]*)["']?\s*[:=]/g;

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode > 1 || (exitCode === 1 && args[0] !== "grep")) throw new Error(`git ${args[0]}: ${stderr.trim()}`);
  return { exitCode, stdout };
}

function count(args: string[], flag: string) {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value < 0) throw new Error(usage);
  return value;
}

function addedNames(diff: string) {
  const names = new Set<string>();
  let patterns: RegExp[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(6);
      patterns = !authored(path) || /\.mdx?$/.test(path) ? [] : /\.(json|ya?ml|toml)$/.test(path) ? [configKey] : codeConcepts;
    } else if (line.startsWith("+")) for (const pattern of patterns) for (const match of line.slice(1).matchAll(pattern)) names.add(match[1]!);
  }
  return [...names];
}

export async function prSize(args: string[], cwd: string) {
  const base = args[args.indexOf("--base") + 1];
  if (!args.includes("--base") || !base) throw new Error(usage);
  const lines = count(args, "--lines");
  const concepts = count(args, "--concepts");
  const from = (await git(cwd, "merge-base", base, "HEAD")).stdout.trim();
  const numstat = (await git(cwd, "diff", "--numstat", from, "HEAD")).stdout.split("\n").map((row) => row.split("\t"));
  const authoredLines = numstat.filter(([, , path]) => path && authored(path)).reduce((sum, [added]) => sum + (Number(added) || 0), 0);
  const newFiles = (await git(cwd, "diff", "--name-only", "--diff-filter=A", from, "HEAD")).stdout.split("\n").filter((path) => path && authored(path));
  const names = addedNames((await git(cwd, "diff", "-U0", from, "HEAD")).stdout);
  const newConcepts = [];
  for (const name of names) if ((await git(cwd, "grep", "-q", "-F", "-e", name, from)).exitCode === 1) newConcepts.push(name);
  const counted = (count: number, noun: string, items: string[] = []) => `${count} ${noun}${count === 1 ? "" : "s"}${items.length ? ` (${items.join(", ")})` : ""}`;
  const summary = `size: ${counted(authoredLines, "authored line")}, ${counted(newFiles.length, "new file", newFiles)}, ${counted(newConcepts.length, "new concept", newConcepts)}`;
  if (lines === undefined && concepts === undefined) return { output: `${summary}\nno estimate: the size contract did not run`, exitCode: 0 };
  const estimate = [lines === undefined ? "" : counted(lines, "line"), concepts === undefined ? "" : counted(concepts, "concept")].filter(Boolean).join(" and ");
  const over = (lines !== undefined && authoredLines > 1.5 * lines) || (concepts !== undefined && newConcepts.length > 1.5 * concepts);
  return over
    ? { output: `${summary}\nover 1.5 times the estimate of ${estimate}: run the delete pass`, exitCode: 1 }
    : { output: `${summary}\nwithin the estimate of ${estimate}`, exitCode: 0 };
}
