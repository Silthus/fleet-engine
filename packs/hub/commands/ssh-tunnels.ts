import { homedir, hostname } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { numberSetting, optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import { peerMachine } from "../lib/machine.ts";
import { run } from "../lib/run.ts";
import { sshTunnels, tunnelTargets, type TunnelMode } from "../lib/tunnels.ts";

const modes = ["plan", "install", "doctor"];

await runCommand(() => {
  const [mode = "plan", ...rest] = Bun.argv.slice(2);
  if (rest.length || !modes.includes(mode)) return console.error("Usage: fleet ssh-tunnels [plan|install|doctor]"), 2;
  const alias = stringSetting("hub.alias");
  return sshTunnels(mode as TunnelMode, {
    home: homedir(), devboxes: tunnelTargets(alias, peerMachine().devboxes, hostname()), relayPort: numberSetting("hub.relayPort"),
    httpsHost: optionalStringSetting("hub.httpsHost"), hosts: "/etc/hosts", run, print: (line) => console.log(line),
  });
}, "fleet ssh-tunnels");
