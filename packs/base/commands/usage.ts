import { homedir } from "node:os";
import { runCommand } from "../lib/command.ts";
import { resolvedSettings } from "../lib/settings.ts";
import { usageCommand } from "../lib/usage-flush.ts";

await runCommand(() => usageCommand(Bun.argv.slice(2), { home: homedir(), settings: resolvedSettings(), send: fetch, wait: Bun.sleep, print: (line) => console.log(line) }), "fleet usage");
