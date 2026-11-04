import { homedir, hostname } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { runActivity } from "../lib/activity.ts";

await runCommand(() => runActivity(Bun.argv.slice(2), { home: homedir(), host: hostname(), print: (line) => console.log(line) }));
