import { basename } from "node:path";
import { nestedProgramsAt, parse, type Command, type Scope } from "./shell-words.ts";

type Finding = { what: string; how: string };
type Reach = "exit" | "printed" | { how: string };
type Program = { commands: Command[]; depths: number[] };

const maxNesting = 8;
const gitValueOptions = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const xargsValueOptions = new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--max-args", "--max-chars", "--max-lines", "--max-procs", "--process-slot-var", "--replace"]);
const openers = new Set(["{", "if", "while", "until"]);
const headers = new Set(["for", "select", "case"]);
const closers = new Set(["}", "fi", "done", "esac"]);
const separators = new Set([undefined, ";", "\n"]);
const readsStatus = (text: string) => /\$(?:\?|\{\?\})/.test(text);
const readsPipeStatusAt = (place: number) => (text: string) => [...text.matchAll(/\$\{PIPESTATUS\[(\d+|@|\*)\]\}/g)].some(([, index]) => index === String(place) || index === "@" || index === "*");
const failingCode = /^(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/;
const printsToTheAgent = /^(?:2>&1|1?>&2)$/;

function gitSubcommandAt(args: string[]): number {
  for (let index = 0; index < args.length; index++) {
    if (gitValueOptions.has(args[index])) index++;
    else if (!args[index].startsWith("-")) return index;
  }
  return args.length;
}

function xargsCommand(args: string[]): { what: string; rest: string[] } | undefined {
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    if (args[index] === "--") {
      index++;
      break;
    }
    index += xargsValueOptions.has(args[index]) ? 2 : 1;
  }
  const [name, ...rest] = args.slice(index);
  return name === undefined ? undefined : statusMatters(basename(name), rest);
}

function statusMatters(name: string, args: string[]): { what: string; rest: string[] } | undefined {
  const [first, second, ...rest] = args;
  if ((name === "hedge" || name === "fleet") && first === "proof" && ["gate", "review", "save"].includes(second ?? "")) return { what: `${name} proof ${second}`, rest };
  if (name === "git") {
    const at = gitSubcommandAt(args);
    return args[at] === "push" || args[at] === "commit" ? { what: `git ${args[at]}`, rest: args.slice(at + 1) } : undefined;
  }
  if (name === "gh" && first === "pr" && (second === "ready" || second === "merge")) return { what: `gh pr ${second}`, rest };
  if (name === "gh" && first === "run" && second === "watch" && rest.includes("--exit-status")) return { what: "gh run watch --exit-status", rest };
  if (name === "xargs") return xargsCommand(args);
  return undefined;
}

function guardedName({ name, args }: Command): string | undefined {
  const found = statusMatters(name, args);
  const asksHelp = found?.rest.length === 1 && (found.rest[0] === "--help" || found.rest[0] === "-h");
  return asksHelp ? undefined : found?.what;
}

const parens = (scope: Scope): number => (scope.parent ? 1 + parens(scope.parent) : 0);

function depthsOf(commands: Command[]): number[] {
  let level = 0;
  return commands.map((command) => {
    level += command.keywords.filter((word) => openers.has(word)).length;
    if (closers.has(command.name)) level = Math.max(0, level - 1);
    const depth = level + parens(command.scope);
    if (headers.has(command.name)) level++;
    return depth;
  });
}

function setting({ commands, depths }: Program, before: number, read: (args: string[]) => boolean | undefined): boolean {
  let on = false;
  commands.slice(0, before).forEach((command, index) => {
    if (command.name !== "set" || parens(command.scope) > 0) return;
    const alwaysRuns = depths[index] === 0 && command.keywords.length === 0 && !["|", "&&", "||"].includes(commands[index - 1]?.after ?? "");
    const value = read(command.args);
    if (alwaysRuns && !["|", "&"].includes(command.after ?? "")) on = value ?? on;
    else if (value === false) on = false;
  });
  return on;
}

const setsOption = (option: string) => (args: string[]) => {
  let on: boolean | undefined;
  args.forEach((arg, index) => {
    const flag = args[index - 1] ?? "";
    if (arg === option && /^[-+][A-Za-z]*o$/.test(flag)) on = flag.startsWith("-");
  });
  return on;
};

const setsErrexit = (args: string[]) => {
  let on = setsOption("errexit")(args);
  for (const arg of args) if (/^[-+][A-Za-z]+$/.test(arg) && arg.slice(1).split("o")[0].includes("e")) on = arg.startsWith("-");
  return on;
};

function expanded(raw: string): string {
  let text = "";
  let inDoubleQuotes = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === "\\") index++;
    else if (char === '"') inDoubleQuotes = !inDoubleQuotes;
    else if (char === "'" && !inDoubleQuotes) {
      index = raw.indexOf("'", index + 1);
      if (index < 0) break;
    } else if (char === "$" && raw[index + 1] === "'" && !inDoubleQuotes) {
      for (index += 2; index < raw.length && raw[index] !== "'"; index++) if (raw[index] === "\\") index++;
    } else text += char;
  }
  return text;
}

type Reads = { status: (text: string) => boolean; bareExit: boolean; failingExit: boolean };

function printsStatus({ name, args, rawArgs }: Command, reads: (text: string) => boolean): boolean {
  return name === "echo" && !args.some((arg) => arg.includes("\\")) && rawArgs.some((raw) => reads(expanded(raw)));
}

function reporter(command: Command | undefined, sameLevel: boolean, reads: Reads): Reach | undefined {
  if (!command || !sameLevel || command.keywords.length > 0 || command.after === "|" || command.substitutions.length > 0) return undefined;
  if (command.name === "exit") {
    const [code, ...more] = command.args;
    if (more.length > 0) return undefined;
    const readsIt = command.rawArgs.some((raw) => reads.status(expanded(raw)));
    return (code === undefined && reads.bareExit) || readsIt || (reads.failingExit && failingCode.test(code ?? "")) ? "exit" : undefined;
  }
  return printsStatus(command, reads.status) && command.redirects.every((redirect) => printsToTheAgent.test(redirect)) ? "printed" : undefined;
}

function placeInPipe({ commands, depths }: Program, start: number): number | undefined {
  let place = 0;
  for (let index = start - 1; index >= 0 && commands[index].after === "|"; index--) {
    if (depths[index] !== depths[start] || closers.has(commands[index].name)) return undefined;
    place++;
  }
  return place;
}

function statementEnd({ commands, depths }: Program, start: number, depth: number): number {
  if (depths[start] <= depth && !headers.has(commands[start].name)) return start;
  const outside = depths.findIndex((each, index) => index > start && each <= depth);
  if (outside < 0) return commands.length - 1;
  return closers.has(commands[outside].name) && depths[outside] === depth ? outside : outside - 1;
}

function pipelineEnd(program: Program, start: number, depth: number): number {
  let end = statementEnd(program, start, depth);
  while (program.commands[end].after === "|" && end + 1 < program.commands.length) end = statementEnd(program, end + 1, depth);
  return end;
}

function closesOnly({ commands, depths }: Program, end: number, depth: number): boolean {
  if (!separators.has(commands[end].after) && commands[end].after !== ";;") return false;
  return commands.slice(end + 1).every((command, offset) => closers.has(command.name) && command.name !== "done" && depths[end + 1 + offset] < depth && separators.has(command.after));
}

const separatorName = (after: string | undefined) => (after === "\n" ? "the next line after it" : `the \`${after}\` after it`);

function reachOf(program: Program, start: number): Reach {
  const { commands, depths } = program;
  const depth = depths[start];
  const sameLevel = (index: number) => depths[index] === depth;
  let end = pipelineEnd(program, start, depth);
  if (end !== start && !setting(program, start, setsOption("pipefail"))) {
    const place = placeInPipe(program, start);
    const readable = depth === 0 && place !== undefined && (separators.has(commands[end].after) || commands[end].after === "&&");
    const reads = { status: readsPipeStatusAt(place ?? -1), bareExit: false, failingExit: false };
    return (readable && reporter(commands[end + 1], sameLevel(end + 1), reads)) || { how: "a pipe" };
  }
  if (depth > 0) return closesOnly(program, end, depth) ? "exit" : { how: "the group or loop it runs in" };
  let chained = false;
  while (commands[end].after === "&&" && end + 1 < commands.length) {
    end = pipelineEnd(program, end + 1, depth);
    chained = true;
  }
  const after = commands[end].after;
  const next = end + 1;
  if (after === undefined) return "exit";
  if (after === "&") return { how: "running it in the background with `&`" };
  if (after === "||") return reporter(commands[next], sameLevel(next), { status: readsStatus, bareExit: true, failingExit: true }) ?? { how: "the `||` after it" };
  if (!chained && separators.has(after) && setting(program, start, setsErrexit)) return "exit";
  return reporter(commands[next], sameLevel(next), { status: readsStatus, bareExit: true, failingExit: false }) ?? { how: separatorName(after) };
}

function hiddenIn(text: string, nesting: number): { found?: Finding; carries?: string } {
  if (nesting > maxNesting) throw new Error(`it nests more than ${maxNesting} shell programs`);
  const pipelines = parse(text);
  const guarded: (string | undefined)[] = [];
  for (const pipeline of pipelines) {
    for (const [index, command] of pipeline.entries()) {
      let what = guardedName(command);
      for (const inner of nestedProgramsAt(pipeline, index)) {
        const { found, carries } = hiddenIn(inner.program, nesting + 1);
        if (found) return { found };
        if (!carries) continue;
        const assignsProcess = [...command.env.values()].some((value) => /[<>]\(/.test(value));
        const passesOn = !inner.substituted || (command.name === "" && command.substitutions.length === 1 && !assignsProcess);
        if (!passesOn) return { found: { what: carries, how: "the `$(…)` substitution it runs in" } };
        what ??= carries;
      }
      guarded.push(what);
    }
  }
  const commands = pipelines.flat();
  const program = { commands, depths: depthsOf(commands) };
  let carries: string | undefined;
  for (const [index, command] of commands.entries()) {
    const what = guarded[index];
    if (!what || command.tested) continue;
    const reach = reachOf(program, index);
    if (typeof reach === "object") return { found: { what, how: reach.how } };
    if (reach === "printed" && nesting > 0) return { found: { what, how: "the nested shell or `$(…)` that prints it" } };
    carries ??= what;
  }
  return { carries };
}

export const exitMaskReason = (what: string, how: string, person: string) => `Hedge blocked this command: ${how} hides the exit status of \`${what}\`, `
  + "so a failure reads as a success. These forms pass: run it alone or as the last command; chain the next step with `&&`; "
  + `print its status on the next command, as in \`${what} … > /tmp/out.log 2>&1; echo "exit=$?"; cat /tmp/out.log\`; `
  + "for a pipe, start with `set -o pipefail;`, or print `${PIPESTATUS[n]}` right after it, where n is its place in the pipe, counted from 0. "
  + "A call with only `--help` or `-h` after the command passes too. "
  + `If you are not sure, stop and ask ${person}.`;

export function exitMaskRisk(command: string, person: string): string | undefined {
  const { found } = hiddenIn(command, 0);
  return found && exitMaskReason(found.what, found.how, person);
}
