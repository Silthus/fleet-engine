import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pipelinesIn, shellInput, shells, type Command, type Scope } from "./shell-words.ts";

const downloaders = new Set(["curl", "wget"]);
const stdinInterpreters = new Set(["python", "python3", "node", "bun", "deno", "perl", "ruby", "php", "pwsh"]);
const fileInterpreters = new Set([...shells, ...stdinInterpreters, "source", "."]);
const substitutionRunners = new Set([...fileInterpreters, "eval"]);
const inlineCodeFlags = new Set(["-c", "-e", "--eval", "-p", "--print", "-m", "-r"]);
const runners = new Set(["npx", "bunx", "uvx", "pnpx", "pnpm dlx", "bun x", "yarn dlx", "npm exec", "npm x", "pipx run"]);
const packageFlags = new Set(["-p", "--package", "--from", "--spec"]);
const valueFlags = new Set(["--with", "--python", "--registry", "--cache"]);
const valuedLetters = { curl: "AbcCdDeEFHKmoPQrTtuUwxXyYz", wget: "OoaeiPtTwQUB" };
const gitValuedGlobals = new Set(["-c", "-C", "--config-env", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source", "--list-cmds"]);
const gitConfigValued = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value"]);
const gitConfigReads = new Set(["get", "list", "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "-l", "--list", "-e", "--edit", "edit"]);
const gitConfigWrites = new Set(["set", "unset", "rename-section", "remove-section", "--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section"]);
const gitBypassEnv = /^GIT_CONFIG_(?:NOSYSTEM|SYSTEM|COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/;
const rewriteKey = /^(?:url|protocol)\./i;

const networkCodeReason = (person: string) => "Fleet blocked this command: it runs code straight from the network. "
  + "Download the file into a new, empty directory as its own step, read it, and run it only if it does what you expect "
  + `and ${person} asked for this tool. If you are not sure, stop and ask ${person}.`;

const runnerReason = (runner: string, name: string, person: string) => `Fleet blocked this command: \`${runner} ${name}\` downloads and runs a package `
  + "that this project does not have. Use a tool that the project's lockfile already pins, or add it as a dev dependency "
  + `(\`pnpm add -D\` or \`bun add -d\`). If you need a one-off tool, stop and ask ${person}.`;

const gitBypassReason = (person: string) => "Fleet blocked this command: it changes how Git maps or allows URLs, which goes around the Git allowlist. "
  + `Use the URL as it is. If its owner is blocked, stop and ask ${person} to add it to the list.`;

function readsProgramFromStdin(command: Command): boolean {
  const input = shellInput(command);
  if (input) return "stdin" in input;
  if (!stdinInterpreters.has(command.name)) return false;
  if (command.args.some((arg) => inlineCodeFlags.has(arg))) return false;
  return command.args.includes("-") || !command.args.some((arg) => !arg.startsWith("-"));
}

function pipesDownloadIntoInterpreter(pipeline: Command[]): boolean {
  const download = pipeline.findIndex((command) => downloaders.has(command.name));
  return download >= 0 && pipeline.slice(download + 1).some(readsProgramFromStdin);
}

function lastProgramArgument(command: Command): number {
  if (command.name === "eval") return command.args.length - 1;
  if (command.name === "source" || command.name === ".") return 0;
  const input = shellInput(command);
  if (input) return "index" in input ? input.index : -1;
  const inlineFlag = command.args.findIndex((arg) => inlineCodeFlags.has(arg));
  return inlineFlag >= 0 ? inlineFlag + 1 : command.args.findIndex((arg) => arg === "-" || !arg.startsWith("-"));
}

function programSubstitutions(command: Command): string[] {
  const fromStdin = command.stdin && readsProgramFromStdin(command) ? command.stdin.substitutions : [];
  return [...command.leadingSubstitutions, ...command.argSubstitutions.slice(0, lastProgramArgument(command) + 1).flat(), ...fromStdin];
}

const runsDownloadedSubstitution = (command: Command) => substitutionRunners.has(command.name)
  && programSubstitutions(command).some((program) => pipelinesIn(program).flat().some((inner) => downloaders.has(inner.name)));

const urlFileName = (url: string) => url.replace(/[?#].*$/, "").replace(/^[a-z]+:\/\/[^/]*/i, "");

function downloadedFiles(command: Command): string[] {
  if (command.name !== "curl" && command.name !== "wget") return [];
  const outputLetter = command.name === "curl" ? "o" : "O";
  const files = [...command.outputs];
  const urls = command.args.filter((arg) => /^https?:\/\//.test(arg));
  let remoteName = false;
  for (let index = 0; index < command.args.length; index++) {
    const arg = command.args[index];
    if (arg === "--output" || arg === "--output-document") files.push(command.args[++index] ?? "");
    else if (/^--output(?:-document)?=/.test(arg)) files.push(arg.slice(arg.indexOf("=") + 1));
    else if (arg === "--remote-name" || arg === "--remote-name-all") remoteName = true;
    else if (/^-[A-Za-z]/.test(arg)) {
      for (let letter = 1; letter < arg.length; letter++) {
        if (command.name === "curl" && arg[letter] === "O") remoteName = true;
        if (!valuedLetters[command.name].includes(arg[letter])) continue;
        const value = arg.slice(letter + 1) || (command.args[++index] ?? "");
        if (arg[letter] === outputLetter) files.push(value);
        break;
      }
    }
  }
  if (remoteName || (command.name === "wget" && files.length === 0)) files.push(...urls.map(urlFileName));
  return files.filter((file) => file !== "-").map((file) => basename(file)).filter(Boolean);
}

const executableMode = (mode: string) => /\+[rw]*x/.test(mode) || (/^[0-7]{3,4}$/.test(mode) && /[1357]/.test(mode));

function runsDownloadedFile(pipelines: Command[][]): boolean {
  const downloaded = new Set<string>();
  for (const pipeline of pipelines) {
    for (const { name, args } of pipeline) {
      const operands = args.filter((arg) => !arg.startsWith("-")).map((arg) => basename(arg));
      if (downloaded.has(name)) return true;
      if (fileInterpreters.has(name) && downloaded.has(operands[0] ?? "")) return true;
      if (name === "chmod" && args.some(executableMode) && operands.some((operand) => downloaded.has(operand))) return true;
    }
    for (const file of pipeline.flatMap(downloadedFiles)) downloaded.add(file);
  }
  return false;
}

function gitConfigKeys(args: string[]): string[] {
  return args.flatMap((arg, index) => {
    if (arg === "-c" || arg === "--config" || arg === "--config-env") return [args[index + 1] ?? ""];
    return arg.match(/^(?:--config(?:-env)?=|-c)(.+)$/s)?.slice(1) ?? [];
  });
}

function writtenConfigKeys(args: string[]): string[] {
  const operands: string[] = [];
  let action: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (gitConfigValued.has(arg)) index++;
    else if (operands.length === 0 && !action && (gitConfigReads.has(arg) || gitConfigWrites.has(arg))) action = arg;
    else if (!arg.startsWith("-")) operands.push(arg);
  }
  if (action && gitConfigReads.has(action)) return [];
  if (/rename-section$/.test(action ?? "")) return operands.slice(0, 2);
  return action || operands.length >= 2 ? operands.slice(0, 1) : [];
}

function changesGitUrls(command: Command): boolean {
  if ([...command.env.keys()].some((key) => gitBypassEnv.test(key))) return true;
  if (command.name !== "git") return false;
  let index = 0;
  while (command.args[index]?.startsWith("-")) index += gitValuedGlobals.has(command.args[index]) ? 2 : 1;
  const [subcommand, ...rest] = command.args.slice(index);
  const keys = [
    ...gitConfigKeys(command.args.slice(0, index)),
    ...(subcommand === "clone" ? gitConfigKeys(rest) : []),
    ...(subcommand === "config" ? writtenConfigKeys(rest) : []),
  ];
  return keys.some((key) => rewriteKey.test(key));
}

function requestedPackages(args: string[]): { packages: string[]; tool?: string } {
  const packages: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (packageFlags.has(arg)) packages.push(args[++index] ?? "");
    else if (/^--(?:package|from|spec)=/.test(arg)) packages.push(arg.slice(arg.indexOf("=") + 1));
    else if (/^-p./.test(arg)) packages.push(arg.slice(2).replace(/^=/, ""));
    else if (valueFlags.has(arg)) index++;
    else if (arg === "--") return { packages, tool: args[index + 1] };
    else if (!arg.startsWith("-")) return { packages, tool: arg };
  }
  return { packages };
}

const bareName = (name: string) => name.replace(/(?<=.)@.*$/, "").replace(/\[.*$/, "").replace(/[<>=~].*$/, "");

function nearest(cwd: string | undefined, paths: (directory: string) => string[]): string | undefined {
  for (let directory = cwd; directory; directory = dirname(directory) === directory ? undefined : dirname(directory)) {
    const found = paths(directory).find((path) => existsSync(path));
    if (found) return found;
  }
  return undefined;
}

const inProject = (cwd: string | undefined, paths: (directory: string) => string[]) => nearest(cwd, paths) !== undefined;

const hasPackage = (name: string, cwd: string | undefined) =>
  inProject(cwd, (directory) => [join(directory, "node_modules", name, "package.json"), ...(name.includes("/") ? [] : [join(directory, ".venv", "bin", name)])]);

const hasTool = (name: string, cwd: string | undefined) => hasPackage(name, cwd)
  || (!name.includes("/") && (Bun.which(name) !== null || inProject(cwd, (directory) => [join(directory, "node_modules", ".bin", name)])));

const npmRange = (spec: string) => spec.match(/^@?[^@]+@(.+)$/)?.[1];

function installedVersion(name: string, cwd: string | undefined): string | undefined {
  const manifest = nearest(cwd, (directory) => [join(directory, "node_modules", name, "package.json")]);
  if (!manifest) return undefined;
  const { version } = JSON.parse(readFileSync(manifest, "utf8"));
  return typeof version === "string" ? version : undefined;
}

function hasVersion(spec: string, cwd: string | undefined): boolean {
  const range = npmRange(spec);
  if (range === undefined) return true;
  const version = installedVersion(bareName(spec), cwd);
  return version !== undefined && Bun.semver.satisfies(version, range);
}

function missingPackage(command: Command, cwd: string | undefined): { runner: string; name: string } | undefined {
  const two = `${command.name} ${command.args[0]}`;
  const runner = runners.has(two) ? two : runners.has(command.name) ? command.name : undefined;
  if (!runner) return undefined;
  const { packages, tool } = requestedPackages(command.args.slice(runner === two ? 1 : 0));
  const specs = packages.length > 0 ? packages : tool ? [tool] : [];
  const check = packages.length > 0 ? hasPackage : hasTool;
  for (const spec of specs) {
    if (!check(bareName(spec), cwd)) return { runner, name: bareName(spec) };
    if (!hasVersion(spec, cwd)) return { runner, name: spec };
  }
  return undefined;
}

function changedDirectory(cwd: string | undefined, args: string[]): string | undefined {
  const target = args.find((arg) => !/^-[LPe@]+$/.test(arg));
  if (target === undefined || target === "-" || /[$`~]/.test(target)) return undefined;
  if (isAbsolute(target)) return resolve(target);
  return cwd === undefined ? undefined : resolve(cwd, target);
}

function unknownPackageRun(commands: Command[], cwd: string, person: string): string | undefined {
  const directories = new Map<Scope, string | undefined>();
  const directoryOf = (scope: Scope): string | undefined => {
    if (!directories.has(scope)) {
      const start = scope.parent ? directoryOf(scope.parent) : cwd;
      directories.set(scope, scope.chdir === undefined ? start : changedDirectory(start, [scope.chdir]));
    }
    return directories.get(scope);
  };
  for (const command of commands) {
    const directory = directoryOf(command.scope);
    if (command.name === "cd" || command.name === "pushd") directories.set(command.scope, changedDirectory(directory, command.args));
    else if (command.name === "popd") directories.set(command.scope, undefined);
    const missing = missingPackage(command, command.chdir === undefined ? directory : changedDirectory(directory, [command.chdir]));
    if (missing) return runnerReason(missing.runner, missing.name, person);
  }
  return undefined;
}

/** Refuses network code piped into an interpreter or run from a fresh download, a package runner that fetches a package
 * the project lacks, and Git settings that go around the Git allowlist. */
export function downloadRisk(command: string, cwd: string, person: string): string | undefined {
  const pipelines = pipelinesIn(command);
  const commands = pipelines.flat();
  if (commands.some(changesGitUrls)) return gitBypassReason(person);
  if (pipelines.some(pipesDownloadIntoInterpreter) || commands.some(runsDownloadedSubstitution) || runsDownloadedFile(pipelines)) return networkCodeReason(person);
  return unknownPackageRun(commands, cwd, person);
}
