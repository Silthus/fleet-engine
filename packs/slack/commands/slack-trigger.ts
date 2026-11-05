import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { slackTrigger } from "../lib/command.ts";

await runCommand(() => slackTrigger(Bun.argv.slice(2), { env: Bun.env, home: homedir(), print: (line) => console.log(line), readStdin: () => Bun.stdin.text() }), "fleet slack-trigger");
