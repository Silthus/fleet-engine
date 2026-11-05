import { homedir, hostname } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { diskWatchCommand } from "../lib/disk-watch.ts";

await runCommand(() => diskWatchCommand(Bun.argv.slice(2), {
  home: homedir(), env: Bun.env, self: hostname(), now: Date.now, log: (line) => console.log(`${new Date().toISOString()} ${line}`),
}), "fleet disk-watch");
