import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { providersCommand } from "../lib/availability.ts";

await runCommand(() => providersCommand(Bun.argv.slice(2), {
  home: homedir(), env: Bun.env, fetch, now: Date.now, print: (line) => console.log(line),
}), "fleet providers");
