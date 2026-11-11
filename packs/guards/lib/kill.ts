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
const selfSafe = (args: string[]) => args.some((arg) => !arg.startsWith("-") && /\[[^\]]+\]/.test(arg));
const fullLineMatch = ({ name, args }: Command) => (name === "pkill" || name === "pgrep") && matchesFullLine(args) && !selfSafe(args);
const kills = ({ name, args }: Command) => name === "kill" || name === "pkill" || (name === "xargs" && args.includes("kill"));

/** Refuses `pkill -f`, and `pgrep -f` that feeds a kill or runs in a loop: both match the tool's own `bash -c` shell. */
export function killRisk(command: string, person: string): string | undefined {
  const commands = commandsIn(command);
  const matches = commands.filter(fullLineMatch);
  const risky = matches.some((match) => match.name === "pkill" || match.inLoop) || (matches.length > 0 && commands.some(kills));
  return risky ? killReason(person) : undefined;
}
