import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const days = 3;
const minutes = days * 24 * 60;
const seconds = minutes * 60;

export type PackageAgeInputs = { home: string; platform: NodeJS.Platform; xdgConfigHome?: string; print: (line: string) => void };

const pnpmConfig = ({ home, platform, xdgConfigHome }: PackageAgeInputs) =>
  join(xdgConfigHome || (platform === "darwin" ? join(home, "Library/Preferences") : join(home, ".config")), "pnpm/config.yaml");
const bunConfig = ({ home, xdgConfigHome }: PackageAgeInputs) => join(xdgConfigHome || home, ".bunfig.toml");

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const withNewline = (text: string) => (text && !text.endsWith("\n") ? `${text}\n` : text);

function pnpmWithAge(text: string) {
  if (/^minimumReleaseAge\s*:/m.test(text)) return text;
  return `${withNewline(text)}minimumReleaseAge: ${minutes}\n`;
}

function bunWithAge(text: string) {
  const lines = text.split("\n");
  const install = lines.findIndex((line) => /^\s*\[install\]\s*(#.*)?$/.test(line));
  if (install < 0) return `${withNewline(text)}${text.trim() ? "\n" : ""}[install]\nminimumReleaseAge = ${seconds}\n`;
  const end = lines.findIndex((line, index) => index > install && /^\s*\[/.test(line));
  const section = lines.slice(install + 1, end < 0 ? undefined : end);
  if (section.some((line) => /^\s*minimumReleaseAge\s*=/.test(line))) return text;
  return [...lines.slice(0, install + 1), `minimumReleaseAge = ${seconds}`, ...lines.slice(install + 1)].join("\n");
}

/** Adds a three-day minimum release age to the user pnpm and Bun config where it is missing; with --check, exits 1 while one is missing. */
export function packageAgeCommand(args: string[], inputs: PackageAgeInputs): number {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error("usage: fleet package-age [--check]");
  const files = [
    { path: pnpmConfig(inputs), add: pnpmWithAge },
    { path: bunConfig(inputs), add: bunWithAge },
  ];
  const missing = files.filter(({ path, add }) => add(read(path)) !== read(path));
  if (args[0] === "--check") return missing.length ? 1 : 0;
  for (const { path, add } of missing) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, add(read(path)));
    inputs.print(`Added a ${days}-day minimum release age to ${path}.`);
  }
  return 0;
}
