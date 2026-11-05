import { homedir, hostname } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { peerMachine } from "../lib/machine.ts";
import { peersCommand } from "../lib/peers.ts";

await runCommand(() => peersCommand(Bun.argv.slice(2), peerMachine(Bun.env, homedir(), hostname(), "Fleet peers")), "fleet peers");
