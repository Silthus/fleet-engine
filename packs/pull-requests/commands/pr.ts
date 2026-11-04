import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { prCommand } from "../lib/pr.ts";

await runCommand(() => prCommand(Bun.argv.slice(2), Bun.env.HOME ?? homedir()), "fleet pr");
