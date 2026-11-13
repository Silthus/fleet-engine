import { basename } from "node:path";

export type Scope = { parent?: Scope; chdir?: string };

export type Command = {
  name: string;
  args: string[];
  env: ReadonlyMap<string, string>;
  substitutions: string[];
  leadingSubstitutions: string[];
  argSubstitutions: string[][];
  stdin?: { body: string; substitutions: string[] };
  outputs: string[];
  inLoop: boolean;
  scope: Scope;
  chdir?: string;
};

type Context = { env: ReadonlyMap<string, string>; inLoop: boolean; scope?: Scope };
type Word = { text: string; raw: string; substitutions: string[] };
type Heredoc = { delimiter: string; literal: boolean; stripTabs: boolean; body: string; substitutions: string[] };
type Token = { word: Word } | { operator: string } | { heredoc: Heredoc } | { herestring: true };

export const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const maxDepth = 8;
const operators = ["&&", "||", ";;", "|&", ";", "|", "&", "(", ")", "\n"];
const keywords = new Set(["then", "do", "else", "elif", "if", "!", "{", "while", "until"]);
const loops = new Set(["for", "select", "while", "until"]);
const assignment = /^([A-Za-z_]\w*)=(.*)$/s;
const redirect = /^(\d+|&)?(>>|>\||>&|<&|<>|>|<)(?!\()/;
const wrappers: Record<string, { valued: string[]; operands?: number; chdir?: string[] }> = {
  sudo: { chdir: ["-D", "--chdir"], valued: ["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-T", "--command-timeout", "-U", "--other-user"] },
  doas: { valued: ["-u", "-C"] },
  env: { chdir: ["-C", "--chdir"], valued: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0"] },
  nice: { valued: ["-n", "--adjustment"] },
  ionice: { valued: ["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"] },
  timeout: { valued: ["-s", "--signal", "-k", "--kill-after"], operands: 1 },
  time: { valued: ["-f", "--format", "-o", "--output"] },
  exec: { valued: ["-a"] },
  stdbuf: { valued: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  caffeinate: { valued: ["-t", "-w"] },
  nohup: { valued: [] },
  setsid: { valued: [] },
  command: { valued: [] },
  builtin: { valued: [] },
};

function parenEnd(text: string, open: number): number {
  let depth = 0;
  const pending: Heredoc[] = [];
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "'") index = quoteEnd(text, index + 1, "'");
    else if (char === '"') index = doubleQuoted(text, index + 1, true).end;
    else if (char === "`") index = quoteEnd(text, index + 1, "`");
    else if (char === "$" && text[index + 1] === "'") index = ansiQuoteEnd(text, index + 2);
    else if (char === "$" && text[index + 1] === "{") index = braceEnd(text, index + 2);
    else if (char === "#" && /[\s;&|()]/.test(text[index - 1] ?? "")) {
      const newline = text.indexOf("\n", index);
      index = (newline < 0 ? text.length : newline) - 1;
    }
    else if (text.startsWith("<<", index) && text[index + 2] !== "<") {
      const stripTabs = text[index + 2] === "-";
      const { delimiter, literal, end } = readDelimiter(text, index + (stripTabs ? 3 : 2));
      pending.push({ delimiter, literal, stripTabs, body: "", substitutions: [] });
      index = end - 1;
    } else if (char === "\n" && pending.length > 0) index = readBodies(text, index + 1, pending) - 1;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index;
  }
  return text.length;
}

function quoteEnd(text: string, start: number, quote: string): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\\" && quote !== "'") index++;
    else if (text[index] === quote) return index;
  }
  return text.length;
}

function ansiQuoteEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === "'") return index;
  }
  return text.length;
}

const backtickProgram = (inner: string) => inner.replace(/\\([`\\$])/g, "$1");

function braceEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === "}") return index;
    else index = expansion(text, index)?.end ?? index;
  }
  return text.length;
}

const programsInside = (inner: string) => doubleQuoted(inner, 0, false).substitutions;

function expansion(text: string, index: number): { end: number; programs: string[] } | undefined {
  if (text[index] === "`") {
    const end = quoteEnd(text, index + 1, "`");
    return { end, programs: [backtickProgram(text.slice(index + 1, end))] };
  }
  if (text[index] !== "$") return undefined;
  if (text.startsWith("$((", index)) {
    const end = parenEnd(text, index + 1);
    return { end, programs: programsInside(text.slice(index + 3, end - 1)) };
  }
  if (text[index + 1] === "(") {
    const end = parenEnd(text, index + 1);
    return { end, programs: [text.slice(index + 2, end)] };
  }
  if (text[index + 1] === "{") {
    const end = braceEnd(text, index + 2);
    return { end, programs: programsInside(text.slice(index + 2, end)) };
  }
  return undefined;
}

function doubleQuoted(text: string, start: number, stopAtQuote: boolean) {
  let value = "";
  const substitutions: string[] = [];
  let index = start;
  for (; index < text.length; index++) {
    const char = text[index];
    if (stopAtQuote && char === '"') break;
    if (char === "\\" && /[$`"\\\n]/.test(text[index + 1] ?? "")) {
      if (text[index + 1] !== "\n") value += text[index + 1];
      index++;
      continue;
    }
    const found = expansion(text, index);
    if (found) {
      substitutions.push(...found.programs);
      value += text.slice(index, found.end + 1);
      index = found.end;
    } else value += char;
  }
  return { value, substitutions, end: index };
}

function readDelimiter(text: string, start: number) {
  let index = start;
  while (text[index] === " " || text[index] === "\t") index++;
  let delimiter = "";
  let literal = false;
  for (; index < text.length && !/[\s;&|()<>]/.test(text[index]); index++) {
    const char = text[index];
    if (char === "'" || char === '"') {
      const end = quoteEnd(text, index + 1, char);
      delimiter += text.slice(index + 1, end);
      literal = true;
      index = end;
    } else if (char === "\\") {
      delimiter += text[++index] ?? "";
      literal = true;
    } else delimiter += char;
  }
  return { delimiter, literal, end: index };
}

function readBodies(text: string, start: number, pending: Heredoc[]): number {
  let index = start;
  for (const heredoc of pending) {
    while (index < text.length) {
      const lineEnd = text.indexOf("\n", index) < 0 ? text.length : text.indexOf("\n", index);
      const line = text.slice(index, lineEnd);
      index = lineEnd + 1;
      if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
      heredoc.body += `${line}\n`;
    }
    if (!heredoc.literal) heredoc.substitutions = doubleQuoted(heredoc.body, 0, false).substitutions;
  }
  pending.length = 0;
  return index;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pending: Heredoc[] = [];
  let word: Word | undefined;
  const append = (value: string, raw: string, substitutions: string[] = []) => {
    word ??= { text: "", raw: "", substitutions: [] };
    word.text += value;
    word.raw += raw;
    word.substitutions.push(...substitutions);
  };
  const endWord = () => {
    if (word) tokens.push({ word });
    word = undefined;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === " " || char === "\t") {
      endWord();
      index++;
    } else if (char === "\\") {
      if (next !== "\n") append(next ?? "", text.slice(index, index + 2));
      index += 2;
    } else if (char === "#" && !word) {
      while (index < text.length && text[index] !== "\n") index++;
    } else if (char === "'") {
      const end = quoteEnd(text, index + 1, "'");
      append(text.slice(index + 1, end), text.slice(index, end + 1));
      index = end + 1;
    } else if (char === "$" && next === "'") {
      const end = ansiQuoteEnd(text, index + 2);
      append(text.slice(index + 2, end).replace(/\\(.)/g, "$1"), text.slice(index, end + 1));
      index = end + 1;
    } else if (char === '"') {
      const quoted = doubleQuoted(text, index + 1, true);
      append(quoted.value, text.slice(index, quoted.end + 1), quoted.substitutions);
      index = quoted.end + 1;
    } else if ((char === "<" || char === ">") && next === "(") {
      const end = parenEnd(text, index + 1);
      append(text.slice(index, end + 1), text.slice(index, end + 1), [text.slice(index + 2, end)]);
      index = end + 1;
    } else if (text.startsWith("<<<", index)) {
      endWord();
      tokens.push({ herestring: true });
      index += 3;
    } else if (text.startsWith("<<", index)) {
      endWord();
      const stripTabs = text[index + 2] === "-";
      const { delimiter, literal, end } = readDelimiter(text, index + (stripTabs ? 3 : 2));
      const heredoc: Heredoc = { delimiter, literal, stripTabs, body: "", substitutions: [] };
      tokens.push({ heredoc });
      pending.push(heredoc);
      index = end;
    } else if (char === "\n") {
      endWord();
      tokens.push({ operator: "\n" });
      index = readBodies(text, index + 1, pending);
    } else if ((char === "&" && (next === ">" || /[<>]$/.test(word?.raw ?? ""))) || (char === "|" && /\d*>$/.test(word?.raw ?? ""))) {
      if (char === "&" && next === ">" && !/[<>]$/.test(word?.raw ?? "")) endWord();
      append(char, char);
      index++;
    } else if (/[;&|()]/.test(char)) {
      endWord();
      const operator = operators.find((candidate) => text.startsWith(candidate, index))!;
      tokens.push({ operator });
      index += operator.length;
    } else {
      if ((char === "<" || char === ">") && word && !/^\d+$|[<>&]$/.test(word.raw)) endWord();
      const found = expansion(text, index);
      const end = found?.end ?? index;
      append(text.slice(index, end + 1), text.slice(index, end + 1), found?.programs);
      index = end + 1;
    }
  }
  endWord();
  readBodies(text, text.length, pending);
  return tokens;
}

function withoutRedirects(words: Word[]) {
  const kept: Word[] = [];
  const outputs: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const match = words[index].raw.match(redirect);
    if (!match) {
      kept.push(words[index]);
      continue;
    }
    const [operator, descriptor = "", direction] = match;
    const target = words[index].text.slice(operator.length) || words[++index]?.text || "";
    const writes = direction !== "<" && direction !== "<&" && direction !== ">&" && (descriptor === "" || descriptor === "1" || descriptor === "&");
    if (writes) outputs.push(target);
  }
  return { kept, outputs };
}

function wrapperOption(texts: string[], index: number, valued: string[]): { width: number; name: string; value?: string } {
  const text = texts[index];
  const long = text.match(/^(--[^=]+)=(.*)$/s);
  if (long) return { width: 1, name: long[1], value: long[2] };
  if (valued.includes(text)) return { width: 2, name: text, value: texts[index + 1] };
  if (text.startsWith("--")) return { width: 1, name: text };
  for (let letter = 1; letter < text.length; letter++) {
    const name = `-${text[letter]}`;
    if (!valued.includes(name)) continue;
    return letter === text.length - 1 ? { width: 2, name, value: texts[index + 1] } : { width: 1, name, value: text.slice(letter + 1) };
  }
  return { width: 1, name: text };
}

function skipWrapper(texts: string[], start: number, env: Map<string, string>): { index: number; chdir?: string } {
  const { valued, operands = 0, chdir: chdirOptions = [] } = wrappers[basename(texts[start])];
  let index = start + 1;
  let chdir: string | undefined;
  while (index < texts.length) {
    const text = texts[index];
    const assigned = text.match(assignment);
    if (text === "--") {
      index++;
      break;
    }
    if (text.startsWith("-") && text.length > 1) {
      const option = wrapperOption(texts, index, valued);
      if (chdirOptions.includes(option.name)) chdir = option.value;
      index += option.width;
    } else if (assigned && (texts[start] === "env" || texts[start] === "sudo")) {
      env.set(assigned[1], assigned[2]);
      index++;
    } else break;
  }
  return { index: index + operands, chdir };
}

/** The simple commands of one shell program, grouped by pipeline in the order they run. Wrappers such as `sudo -u root`,
 * `env A=1`, `timeout 5`, `fleet heavy --` and keywords such as `then` are taken off, so `name` is the command that runs. */
export function parse(program: string, context: Context = { env: new Map(), inLoop: false }): Command[][] {
  const env = new Map(context.env);
  const pipelines: Command[][] = [];
  let pipeline: Command[] = [];
  let words: Word[] = [];
  let stdin: Command["stdin"];
  let hereString = false;
  let loopDepth = 0;
  let scope: Scope = context.scope ?? {};

  const finishCommand = () => {
    if (words.length === 0 && !stdin) return;
    const { kept, outputs } = withoutRedirects(words);
    const texts = kept.map((word) => word.text);
    const commandEnv = new Map(env);
    const assigned = new Map<string, string>();
    let chdir: string | undefined;
    let index = 0;
    while (index < texts.length) {
      const text = texts[index];
      const pair = text.match(assignment);
      if (pair) {
        assigned.set(pair[1], pair[2]);
        commandEnv.set(pair[1], pair[2]);
        index++;
      } else if (keywords.has(text)) {
        if (loops.has(text)) loopDepth++;
        index++;
      } else if (wrappers[basename(text)]) {
        const wrapper = skipWrapper(texts, index, commandEnv);
        index = wrapper.index;
        chdir = wrapper.chdir ?? chdir;
      }
      else if (basename(text) === "fleet" && texts[index + 1] === "heavy" && texts.includes("--", index)) index = texts.indexOf("--", index) + 1;
      else break;
    }
    const name = texts[index] === undefined ? "" : basename(texts[index]);
    const args = texts.slice(index + 1);
    const inLoop = context.inLoop || loopDepth > 0;
    if (name === "for" || name === "select") loopDepth++;
    if (name === "done") loopDepth = Math.max(0, loopDepth - 1);
    if (name === "export") for (const pair of args.map((arg) => arg.match(assignment))) if (pair) assigned.set(pair[1], pair[2]);
    if (name === "" || name === "export") for (const [key, value] of assigned) env.set(key, value), commandEnv.set(key, value);
    const substitutions = [...words.flatMap((word) => word.substitutions), ...(stdin?.substitutions ?? [])];
    const leadingSubstitutions = kept.slice(0, index + 1).flatMap((word) => word.substitutions);
    const argSubstitutions = kept.slice(index + 1).map((word) => word.substitutions);
    pipeline.push({ name, args, env: commandEnv, substitutions, leadingSubstitutions, argSubstitutions, stdin, outputs, inLoop, scope, chdir });
    words = [];
    stdin = undefined;
  };
  const finishPipeline = () => {
    finishCommand();
    if (pipeline.length > 0) pipelines.push(pipeline);
    pipeline = [];
  };

  for (const token of tokenize(program)) {
    if ("word" in token && hereString) {
      stdin = { body: token.word.text, substitutions: token.word.substitutions };
      hereString = false;
    } else if ("word" in token) words.push(token.word);
    else if ("herestring" in token) hereString = true;
    else if ("heredoc" in token) stdin = { body: token.heredoc.body, substitutions: token.heredoc.substitutions };
    else if (token.operator === "|" || token.operator === "|&") finishCommand();
    else {
      finishPipeline();
      if (token.operator === "(") scope = { parent: scope };
      if (token.operator === ")") scope = scope.parent ?? scope;
    }
  }
  finishPipeline();
  return pipelines;
}

/** What a shell runs: a program given with `-c`, a script file, or the program on its standard input. */
export function shellInput(command: Command): { program: string; index: number } | { script: string; index: number } | { stdin: true } | undefined {
  if (!shells.has(command.name)) return undefined;
  let inline = false;
  for (let index = 0; index < command.args.length; index++) {
    const arg = command.args[index];
    if (arg === "--" || arg === "-") {
      const operand = command.args[index + 1];
      return inline ? { program: operand ?? "", index: index + 1 } : operand && arg === "--" ? { script: operand, index: index + 1 } : { stdin: true };
    }
    if (/^[-+][oO]$/.test(arg) || arg === "--rcfile" || arg === "--init-file") index++;
    else if (/^-[A-Za-z]+$/.test(arg)) {
      if (arg.includes("n")) return undefined;
      if (arg.includes("c")) inline = true;
      else if (arg.includes("s")) return { stdin: true };
    } else if (!/^(?:--|\+)/.test(arg)) return inline ? { program: arg, index } : { script: arg, index };
  }
  return inline ? { program: "", index: command.args.length } : { stdin: true };
}

function nestedPrograms(command: Command): { program: string; scope: Scope }[] {
  const input = shellInput(command);
  const child = { parent: command.scope, chdir: command.chdir };
  return [
    ...command.substitutions.map((program) => ({ program, scope: { parent: command.scope } })),
    ...(input && "program" in input ? [{ program: input.program, scope: child }] : []),
    ...(input && "stdin" in input && command.stdin !== undefined ? [{ program: command.stdin.body, scope: child }] : []),
    ...(command.name === "eval" ? [{ program: command.args.join(" "), scope: command.scope }] : []),
  ];
}

/** Every pipeline a command line runs, including those in `sh -c` programs, `$(...)` and backtick substitutions, `eval`,
 * and heredocs fed to a shell. A nested program comes before the command that holds it. */
export function pipelinesIn(program: string, context?: Context, depth = 0): Command[][] {
  if (depth > maxDepth) throw new Error(`it nests more than ${maxDepth} shell programs`);
  return parse(program, context).flatMap((pipeline) => [
    ...pipeline.flatMap((command) => nestedPrograms(command).flatMap(({ program: nested, scope }) => pipelinesIn(nested, { ...command, scope }, depth + 1))),
    pipeline,
  ]);
}

export const commandsIn = (program: string) => pipelinesIn(program).flat();
