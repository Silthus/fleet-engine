import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { claudeWrapperCommand } from "../lib/bind.ts";

await runCommand(() => claudeWrapperCommand(Bun.argv.slice(2), { home: homedir(), print: (line) => console.log(line) }), "fleet claude-wrapper");
