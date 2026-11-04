import { join } from "node:path";
import { quote } from "../adapters/jobs/launcher.ts";

/** A leading fleet runs the launcher of the engine at engineRoot, because get.sh puts no fleet on PATH. Other commands stay as they are. */
export function engineCommand(command: string[], engineRoot: string | undefined): string[] {
  return engineRoot && command[0] === "fleet" ? ["/bin/sh", join(engineRoot, "fleet"), ...command.slice(1)] : command;
}

/** The same for a shell command line, such as a human step's command. */
export function engineShellCommand(command: string, engineRoot: string | undefined): string {
  return engineRoot ? command.replace(/^fleet(?=\s|$)/, () => `/bin/sh ${quote(join(engineRoot, "fleet"))}`) : command;
}
