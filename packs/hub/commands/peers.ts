import { homedir, hostname } from "node:os";
import { failedExit, runCommand } from "../../base/lib/command.ts";
import { peerMachine } from "../lib/machine.ts";
import { peerConfigCommand, peersCommand } from "../lib/peers.ts";

const args = Bun.argv.slice(2);
await runCommand(() => peerConfigCommand(args, homedir(), (line) => console.log(line)) ?? peersCommand(args, peerMachine(Bun.env, homedir(), hostname(), "Fleet peers")), "fleet peers", failedExit(args[0]));
