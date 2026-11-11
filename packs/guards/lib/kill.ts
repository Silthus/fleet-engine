import { commandsIn, type Command } from "./shell-words.ts";

export const killReason = (person: string) => "Fleet blocked this command: matching full command lines also matches the agent's own shell, "
  + "which holds this command's text, so it kills the tool call (exit 144) or waits forever. "
  + "Find the PID with `pgrep -a <name>` or `ps`, then `kill <pid>`. "
  + `A bracket pattern such as \`pkill -f '[b]un dev'\` cannot match itself. If you are not sure, stop and ask ${person}.`;

const pgrepValued = "dgGPstuUF";

export function shortCluster(arg: string, letter: string, valued: string): boolean {
  if (!/^-[A-Za-z0-9]+$/.test(arg)) return false;
  for (const char of arg.slice(1)) {
    if (char === letter) return true;
    if (valued.includes(char)) return false;
  }
  return false;
}

const matchesFullLine = (args: string[]) => args.some((arg) => arg === "--full" || shortCluster(arg, "f", pgrepValued));

function matchesItself(pattern: string | undefined, text: string): boolean {
  if (pattern === undefined) return true;
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return true;
  }
}

const pgrepValuedLong = new Set(["--delimiter", "--pgroup", "--group", "--parent", "--session", "--terminal", "--euid", "--uid", "--pidfile", "--signal", "--ns", "--nslist", "--cgroup", "--env"]);
const shellPrefixes = ["", "bash -c ", "/bin/bash -c ", "/usr/bin/bash -c ", "sh -c ", "/bin/sh -c ", "zsh -c ", "/bin/zsh -c ", "/usr/bin/zsh -c "];

function patternOf(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return args[index + 1];
    if (pgrepValuedLong.has(arg)) index++;
    else if (/^-[A-Za-z0-9]+$/.test(arg)) {
      const valued = [...arg.slice(1)].findIndex((char) => pgrepValued.includes(char));
      if (valued === arg.length - 2) index++;
    } else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

const fullLineMatch = ({ name, args }: Command, command: string) => (name === "pkill" || name === "pgrep") && matchesFullLine(args)
  && shellPrefixes.some((prefix) => matchesItself(patternOf(args), `${prefix}${command}`));
const killsComputedPids = ({ name, args }: Command) => (name === "kill" && args.some((arg) => /[$`]/.test(arg))) || (name === "xargs" && args.includes("kill"));

/** Refuses `pkill -f`, and `pgrep -f` that feeds a kill or runs in a loop, when the pattern matches the command's own text:
 * the tool runs it as `bash -c '<command>'`, so that shell matches too. */
export function killRisk(command: string, person: string): string | undefined {
  const commands = commandsIn(command);
  const matches = commands.filter((each) => fullLineMatch(each, command));
  const risky = matches.some((match) => match.name === "pkill" || match.inLoop) || (matches.length > 0 && commands.some(killsComputedPids));
  return risky ? killReason(person) : undefined;
}
