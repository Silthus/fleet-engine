import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

export type LintStagedConfig = Record<string, unknown>;
export type RunCommand = (command: string[], cwd: string, timeoutMs: number) => Promise<string | undefined>;

const configFiles = [".lintstagedrc", ".lintstagedrc.json"];
const rewritesFiles = /(\bformat\b|format:|--write\b|--fix\b|:fix\b)/;
const shellSyntax = /['"`$|&;<>()\\*?{}[\]~#!]/;
const touchesGit = /(^|[\s/])git(\s|$)/;

function matches(pattern: string, path: string): boolean {
  try {
    return new Bun.Glob(pattern).match(pattern.includes("/") ? path : basename(path));
  } catch {
    return false;
  }
}

export function formatCommands(config: LintStagedConfig, root: string, file: string): string[][] {
  const path = relative(root, file);
  if (path.startsWith("..") || path === "") return [];
  const commands = Object.entries(config)
    .filter(([pattern]) => !pattern.startsWith("!") && matches(pattern, path))
    .flatMap(([, value]) => [value].flat())
    .filter((command): command is string => typeof command === "string")
    .map((command) => command.trim())
    .filter((command) => rewritesFiles.test(command) && !shellSyntax.test(command) && !touchesGit.test(command));
  return [...new Set(commands)].map((command) => [...command.split(/\s+/), file]);
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

export async function formatEditedFile(file: string, run: RunCommand, budgetMs: number, now: () => number = Date.now): Promise<string[]> {
  const root = repositoryRoot(dirname(file));
  const config = root && readLintStaged(root);
  if (!root || !config) return [];
  const deadline = now() + budgetMs;
  const findings: string[] = [];
  for (const command of formatCommands(config, root, file)) {
    const left = deadline - now();
    if (left <= 0) break;
    const finding = await run(command, root, left);
    if (finding) findings.push(finding);
  }
  return findings;
}
