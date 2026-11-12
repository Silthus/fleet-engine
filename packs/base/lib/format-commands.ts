import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

export type LintStagedConfig = Record<string, unknown>;
export type RunCommand = (command: string[], cwd: string, timeoutMs: number) => Promise<string | undefined>;
export type FindFormatter = (name: string, root: string) => Promise<string | undefined>;

const configFiles = [".lintstagedrc", ".lintstagedrc.json"];
export const formatters = new Set([
  "prettier", "biome", "eslint", "oxlint", "dprint", "stylelint", "markdownlint", "markdownlint-cli2",
  "ruff", "black", "isort", "gofmt", "goimports", "rustfmt", "shfmt", "clang-format", "taplo", "yamlfmt",
]);
const shellSyntax = /['"`$|&;<>()\\*?{}[\]~#!]/;
const touchesGit = /(^|[\s/])git(\s|$)/;

function matches(pattern: string, path: string): boolean {
  try {
    return new Bun.Glob(pattern).match(pattern.includes("/") ? path : basename(path));
  } catch {
    return false;
  }
}

async function untracked(root: string, path: string): Promise<boolean> {
  try {
    const child = Bun.spawn(["git", "-C", root, "ls-files", "--", relative(root, path)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [listed, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 && listed.trim() === "";
  } catch {
    return false;
  }
}

export const findFormatter: FindFormatter = async (name, root) => {
  const local = join(root, "node_modules/.bin", name);
  if (existsSync(local)) return (await untracked(root, local)) ? local : undefined;
  const found = Bun.which(name);
  return found && isAbsolute(found) && !found.startsWith(`${root}/`) ? found : undefined;
};

async function formatterCommand(command: string, root: string, find: FindFormatter): Promise<string[] | undefined> {
  if (shellSyntax.test(command) || touchesGit.test(command)) return undefined;
  const [program, ...args] = command.split(/\s+/);
  if (!formatters.has(program)) return undefined;
  const path = await find(program, root);
  return path ? [path, ...args] : undefined;
}

export async function formatCommands(config: LintStagedConfig, root: string, file: string, find: FindFormatter = findFormatter): Promise<string[][]> {
  const path = relative(root, file);
  if (path.startsWith("..") || path === "") return [];
  const commands = Object.entries(config)
    .filter(([pattern]) => !pattern.startsWith("!") && matches(pattern, path))
    .flatMap(([, value]) => [value].flat())
    .filter((command): command is string => typeof command === "string")
    .map((command) => command.trim());
  const resolved = await Promise.all([...new Set(commands)].map((command) => formatterCommand(command, root, find)));
  return resolved.filter((command): command is string[] => command !== undefined).map((command) => [...command, file]);
}

export function repositoryRoot(directory: string): string | undefined {
  if (existsSync(join(directory, ".git"))) return directory;
  const parent = dirname(directory);
  return parent === directory ? undefined : repositoryRoot(parent);
}

export function readLintStaged(root: string): LintStagedConfig | undefined {
  try {
    const file = configFiles.map((name) => join(root, name)).find(existsSync);
    const config = file ? JSON.parse(readFileSync(file, "utf8")) : JSON.parse(readFileSync(join(root, "package.json"), "utf8"))["lint-staged"];
    return typeof config === "object" && config !== null && !Array.isArray(config) ? config : undefined;
  } catch {
    return undefined;
  }
}

export async function formatEditedFile(file: string, run: RunCommand, budgetMs: number, now: () => number = Date.now, find: FindFormatter = findFormatter): Promise<string[]> {
  const root = repositoryRoot(dirname(file));
  const config = root && readLintStaged(root);
  if (!root || !config) return [];
  const deadline = now() + budgetMs;
  const findings: string[] = [];
  for (const command of await formatCommands(config, root, file, find)) {
    const left = deadline - now();
    if (left <= 0) break;
    const finding = await run(command, root, left);
    if (finding) findings.push(finding);
  }
  return findings;
}
