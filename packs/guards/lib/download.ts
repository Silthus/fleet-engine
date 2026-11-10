import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { commandWords, pipeline, simpleCommands, statements, withoutHeredocs } from "./shell-words.ts";

const downloaders = new Set(["curl", "wget"]);
const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const interpreters = new Set([...shells, "python", "python3", "node", "bun", "deno", "perl", "ruby", "php", "pwsh", "source", "."]);
const inlineCodeFlags = new Set(["-c", "-e", "--eval", "-p", "--print", "-m", "-r"]);
const runners = new Set(["npx", "bunx", "uvx", "pnpm dlx", "bun x", "yarn dlx", "npm exec", "pipx run"]);
const packageFlags = new Set(["-p", "--package", "--from"]);
const valueFlags = new Set(["--with", "--python", "--registry", "--cache"]);

const networkCodeReason = (person: string) => "Fleet blocked this command: it runs code straight from the network. "
  + "Download the file into a new, empty directory as its own step, read it, and run it only if it does what you expect "
  + `and ${person} asked for this tool. If you are not sure, stop and ask ${person}.`;

const runnerReason = (runner: string, name: string, person: string) => `Fleet blocked this command: \`${runner} ${name}\` downloads and runs a package `
  + "that this project does not have. Use a tool that the project's lockfile already pins, or add it as a dev dependency "
  + `(\`pnpm add -D\` or \`bun add -d\`). If you need a one-off tool, stop and ask ${person}.`;

const gitBypassReason = (person: string) => "Fleet blocked this command: it changes how Git maps or allows URLs, which goes around the Git allowlist. "
  + `Use the URL as it is. If its owner is blocked, stop and ask ${person} to add it to the list.`;

const gitBypass = /\bGIT_CONFIG_(?:NOSYSTEM|SYSTEM|COUNT|KEY_\d+|VALUE_\d+)=|(?:^|\s)-c\s*["']?(?:url|protocol)\.|--config-env[= ]["']?(?:url|protocol)\.|\bgit\s+config\b[^;&|\n]*\s["']?url\./i;
const substitutedDownload = /(?:^|[\s;&|({])(?:sh|bash|zsh|dash|source|\.|eval|python3?|node|bun|perl|ruby)(?=\s)[^;&|\n]*?(?:<\(|\$\(|`)\s*(?:\S*\/)?(?:curl|wget)\b/;

function readsProgramFromStdin([name, ...args]: string[]): boolean {
  if (!interpreters.has(name) || name === "source" || name === ".") return false;
  if (args.some((arg) => inlineCodeFlags.has(arg))) return false;
  if (shells.has(name) && args.includes("-s")) return true;
  if (args.includes("-")) return true;
  return !args.some((arg) => !arg.startsWith("-"));
}

function pipesDownloadIntoInterpreter(statement: string): boolean {
  const parts = pipeline(statement).map(commandWords);
  const download = parts.findIndex((part) => downloaders.has(part[0] ?? ""));
  return download >= 0 && parts.slice(download + 1).some(readsProgramFromStdin);
}

function downloadedFiles(statement: string): string[] {
  const [name, ...args] = commandWords(pipeline(statement)[0] ?? "");
  if (!downloaders.has(name ?? "")) return [];
  const files: string[] = [];
  const url = args.find((arg) => /^https?:\/\//.test(arg));
  const outputFlag = name === "wget" ? "O" : "o";
  args.forEach((arg, index) => {
    const next = args[index + 1];
    const shortFlags = /^-[A-Za-z]+$/.test(arg) ? arg.slice(1) : "";
    if ((shortFlags.endsWith(outputFlag) || ["--output", "--output-document", ">", ">>"].includes(arg)) && next) files.push(next);
    else if (/^--output(?:-document)?=/.test(arg)) files.push(arg.slice(arg.indexOf("=") + 1));
    else if (/^>>?\S/.test(arg)) files.push(arg.replace(/^>>?/, ""));
    else if (name === "curl" && (shortFlags.includes("O") || arg === "--remote-name") && url) files.push(new URL(url).pathname);
  });
  if (name === "wget" && files.length === 0 && url) files.push(new URL(url).pathname);
  return files.map((file) => basename(file)).filter(Boolean);
}

const executableMode = (mode: string) => /\+[rw]*x/.test(mode) || (/^[0-7]{3,4}$/.test(mode) && /[1357]/.test(mode));

function runsDownloadedFile(command: string): boolean {
  const downloaded = new Set<string>();
  for (const statement of statements(command)) {
    for (const part of pipeline(statement)) {
      const [name, ...args] = commandWords(part);
      if (!name) continue;
      const operands = args.filter((arg) => !arg.startsWith("-")).map((arg) => basename(arg));
      if (downloaded.has(name)) return true;
      if (interpreters.has(name) && downloaded.has(operands[0] ?? "")) return true;
      if (name === "chmod" && args.some(executableMode) && operands.some((operand) => downloaded.has(operand))) return true;
    }
    for (const file of downloadedFiles(statement)) downloaded.add(file);
  }
  return false;
}

function packageName(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (packageFlags.has(arg)) return args[index + 1];
    if (/^--(?:package|from)=/.test(arg)) return arg.slice(arg.indexOf("=") + 1);
    if (valueFlags.has(arg)) index++;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

const bareName = (name: string) => name.replace(/(?<=.)@.*$/, "").replace(/\[.*$/, "").replace(/[<>=~].*$/, "");

function installed(name: string, cwd: string): boolean {
  const tool = basename(name);
  if (Bun.which(tool)) return true;
  for (let directory = cwd; ; directory = dirname(directory)) {
    const candidates = [join(directory, "node_modules", ".bin", tool), join(directory, "node_modules", name, "package.json"), join(directory, ".venv", "bin", tool)];
    if (candidates.some((candidate) => existsSync(candidate))) return true;
    if (dirname(directory) === directory) return false;
  }
}

function unknownPackageRun(command: string, cwd: string, person: string): string | undefined {
  for (const [first, second, ...rest] of simpleCommands(command)) {
    const two = `${first} ${second}`;
    const runner = runners.has(two) ? two : runners.has(first ?? "") ? first : undefined;
    if (!runner) continue;
    const found = packageName(runner === two ? rest : [second, ...rest].filter((arg) => arg !== undefined));
    if (!found) continue;
    const name = bareName(found);
    if (!installed(name, cwd)) return runnerReason(runner, name, person);
  }
  return undefined;
}

/** Refuses network code piped into an interpreter or run from a fresh download, a package runner that fetches a package
 * the project lacks, and Git settings that go around the Git allowlist. */
export function downloadRisk(fullCommand: string, cwd: string, person: string): string | undefined {
  const command = withoutHeredocs(fullCommand);
  if (gitBypass.test(command)) return gitBypassReason(person);
  if (substitutedDownload.test(command) || statements(command).some(pipesDownloadIntoInterpreter) || runsDownloadedFile(command)) return networkCodeReason(person);
  return unknownPackageRun(command, cwd, person);
}
