import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { boxCommand } from "../lib/box-command.ts";
import { Coder } from "../lib/coder.ts";
import { dreamHooks } from "../lib/dream/digest.ts";
import { thisMachine, type Machine } from "../lib/machine.ts";

const coderOf = (here: Machine) => new Coder({ home: homedir(), env: Bun.env, coderUrl: here.settings.coderUrl, template: here.settings.template });

await runCommand(() => boxCommand(Bun.argv.slice(2), {
  machine: () => thisMachine(),
  coder: coderOf,
  readStdin: () => Bun.stdin.text(),
  hooks: dreamHooks(Bun.env, homedir(), () => coderOf(thisMachine())),
}), "fleet box");
