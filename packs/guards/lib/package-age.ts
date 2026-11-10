import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const days = 3;
const minutes = days * 24 * 60;
const seconds = minutes * 60;

export type PackageAgeInputs = { home: string; platform: NodeJS.Platform; xdgConfigHome?: string; print: (line: string) => void };

type Config = { path: string; tool: string; key: string; age: number; read: (text: string) => Record<string, unknown> | undefined; add: (text: string) => string };

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const withNewline = (text: string) => (text && !text.endsWith("\n") ? `${text}\n` : text);
const isMapping = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parsed(parse: (text: string) => unknown, text: string) {
  try {
    const value = parse(text);
    return isMapping(value) ? value : {};
  } catch {
    return undefined;
  }
}

const pnpm = (inputs: PackageAgeInputs): Config => ({
  path: join(inputs.xdgConfigHome || (inputs.platform === "darwin" ? join(inputs.home, "Library/Preferences") : join(inputs.home, ".config")), "pnpm/config.yaml"),
  tool: "pnpm",
  key: `minimumReleaseAge: ${minutes}`,
  age: minutes,
  read: (text) => parsed(Bun.YAML.parse, text),
  add: (text) => `${withNewline(text)}minimumReleaseAge: ${minutes}\n`,
});

const installHeader = /^\s*\[\s*(install|"install"|'install')\s*\]\s*(#.*)?\r?$/;

const bun = (inputs: PackageAgeInputs): Config => ({
  path: join(inputs.xdgConfigHome || inputs.home, ".bunfig.toml"),
  tool: "Bun",
  key: `minimumReleaseAge = ${seconds} under [install]`,
  age: seconds,
  read: (text) => {
    const config = parsed(Bun.TOML.parse, text);
    return config && (isMapping(config.install) ? config.install : {});
  },
  add: (text) => {
    const lines = text.split("\n");
    const header = lines.findIndex((line) => installHeader.test(line));
    if (header < 0) return `${withNewline(text)}${text.trim() ? "\n" : ""}[install]\nminimumReleaseAge = ${seconds}\n`;
    const end = lines[header]!.endsWith("\r") ? "\r" : "";
    return [...lines.slice(0, header + 1), `minimumReleaseAge = ${seconds}${end}`, ...lines.slice(header + 1)].join("\n");
  },
});

type Verdict = { config: Config; text: string; state: "set" | "missing" | "unsafe"; next?: string };

function judge(config: Config): Verdict {
  const text = read(config.path);
  const current = config.read(text);
  if (!current) return { config, text, state: "unsafe" };
  if (current.minimumReleaseAge !== undefined) return { config, text, state: "set" };
  const next = config.add(text);
  return config.read(next)?.minimumReleaseAge === config.age ? { config, text, state: "missing", next } : { config, text, state: "unsafe" };
}

/** Adds a three-day minimum release age to the user pnpm and Bun config where it is missing; with --check, exits 1 while one is missing. A config it cannot parse or edit safely stays as it is. */
export function packageAgeCommand(args: string[], inputs: PackageAgeInputs): number {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error("usage: fleet package-age [--check]");
  const verdicts = [judge(pnpm(inputs)), judge(bun(inputs))];
  if (args[0] === "--check") return verdicts.every((verdict) => verdict.state === "set") ? 0 : 1;
  for (const { config, state, next } of verdicts) {
    if (state === "missing" && next !== undefined) {
      mkdirSync(dirname(config.path), { recursive: true });
      writeFileSync(config.path, next);
      inputs.print(`Added a ${days}-day minimum release age to ${config.path}.`);
    }
    if (state === "unsafe") inputs.print(`Kept ${config.path} as it is: Fleet cannot add the setting safely. Add ${config.key} to it by hand, so ${config.tool} installs only versions at least ${days} days old.`);
  }
  return verdicts.some((verdict) => verdict.state === "unsafe") ? 1 : 0;
}
