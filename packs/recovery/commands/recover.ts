import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { recoverCommand } from "../lib/sweep.ts";

await runCommand(() => recoverCommand(Bun.argv.slice(2), {
  home: homedir(), env: Bun.env, fetch, now: Date.now, print: (line) => console.log(`${new Date().toISOString()} ${line}`),
}), "fleet recover");
