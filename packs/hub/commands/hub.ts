import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { hubCommand } from "../lib/machine.ts";

await runCommand(() => hubCommand(Bun.argv.slice(2), { home: homedir(), settings: JSON.parse(Bun.env.FLEET_SETTINGS ?? "{}"), print: (line) => console.log(line) }), "fleet hub");
