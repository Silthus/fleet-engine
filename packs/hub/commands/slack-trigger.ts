import { homedir, hostname } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { slackTriggerCommand } from "../lib/slack-trigger.ts";

await runCommand(() => slackTriggerCommand(Bun.argv.slice(2), {
  home: homedir(), env: Bun.env, self: hostname(), now: Date.now, fetch,
  log: (line) => console.log(`${new Date().toISOString()} ${line}`), print: (line) => console.log(line),
}), "fleet slack-trigger");
