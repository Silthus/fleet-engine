import { homedir } from "node:os";
import { runCommand } from "../lib/command.ts";
import { shellSessionCommand } from "../lib/shell-session.ts";

await runCommand(() => shellSessionCommand(Bun.argv.slice(2), homedir()), "fleet shell-session");
