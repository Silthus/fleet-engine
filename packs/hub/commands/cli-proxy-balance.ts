import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { balanceCommand } from "../lib/cli-proxy-balance.ts";

await runCommand(() => balanceCommand(Bun.argv.slice(2), { home: homedir(), fetch, now: Date.now, log: (line) => console.log(`${new Date().toISOString()} ${line}`) }), "fleet cli-proxy-balance");
