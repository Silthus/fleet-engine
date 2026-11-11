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

const patternOf = (args: string[]) => args.filter((arg) => !arg.startsWith("-")).at(-1);
const fullLineMatch = ({ name, args }: Command, text: string) => (name === "pkill" || name === "pgrep") && matchesFullLine(args) && matchesItself(patternOf(args), text);
const killsComputedPids = ({ name, args }: Command) => (name === "kill" && args.some((arg) => /[$`]/.test(arg))) || (name === "xargs" && args.includes("kill"));

/** Refuses `pkill -f`, and `pgrep -f` that feeds a kill or runs in a loop, when the pattern matches the command's own text:
 * the tool runs it as `bash -c '<command>'`, so that shell matches too. */
export function killRisk(command: string, person: string): string | undefined {
  const commands = commandsIn(command);
  const matches = commands.filter((each) => fullLineMatch(each, command));
  const risky = matches.some((match) => match.name === "pkill" || match.inLoop) || (matches.length > 0 && commands.some(killsComputedPids));
  return risky ? killReason(person) : undefined;
}
