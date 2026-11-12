import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import { boxCommand } from "../lib/box-command.ts";
import { Coder } from "../lib/coder.ts";
import { dreamHooks } from "../lib/dream/digest.ts";
import { peerMachine, thisMachine, type Machine } from "../lib/machine.ts";

const coderOf = (here: Machine) => new Coder({ home: homedir(), env: Bun.env, coderUrl: here.settings.coderUrl, template: here.settings.template });

await runCommand(() => boxCommand(Bun.argv.slice(2), {
  machine: () => thisMachine(),
  coder: coderOf,
  tokens: () => ({ here: peerMachine(), coder: new Coder({ home: homedir(), env: Bun.env, coderUrl: stringSetting("hub.coderUrl"), template: optionalStringSetting("hub.boxTemplate") ?? "" }) }),
  readStdin: () => Bun.stdin.text(),
  hooks: dreamHooks(Bun.env, homedir(), () => coderOf(thisMachine())),
}), "fleet box");
