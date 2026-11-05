import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { boxCommand } from "../lib/box-command.ts";
import { Coder } from "../lib/coder.ts";
import { thisMachine } from "../lib/machine.ts";

await runCommand(() => boxCommand(Bun.argv.slice(2), {
  machine: () => thisMachine(),
  coder: (here) => new Coder({ home: homedir(), env: Bun.env, coderUrl: here.settings.coderUrl, template: here.settings.template }),
  readStdin: () => Bun.stdin.text(),
  hooks: {},
}), "fleet box");
