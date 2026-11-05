import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { diskSweepCommand } from "../lib/disk-sweep.ts";

await runCommand(() => diskSweepCommand(Bun.argv.slice(2), { home: homedir(), env: Bun.env }), "fleet disk-sweep");
