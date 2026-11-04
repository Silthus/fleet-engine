import { homedir, hostname } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { runLanes } from "../lib/lanes.ts";

await runCommand(() => runLanes(Bun.argv.slice(2), { home: homedir(), host: hostname(), now: new Date(), print: (line) => console.log(line) }));
