import { homedir, hostname } from "node:os";
import { failedExit, runCommand } from "../../base/lib/command.ts";
import { numberSetting, optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import { peerMachine, profileDevboxes, proxyOn } from "../lib/machine.ts";
import { run } from "../lib/run.ts";
import { sshTunnels, tunnelTargets, type TunnelMode } from "../lib/tunnels.ts";

const modes = ["plan", "install", "doctor", "remove", "left"];

await runCommand(() => {
  const [mode = "plan", ...rest] = Bun.argv.slice(2);
  if (rest.length || !modes.includes(mode)) return console.error("Usage: fleet ssh-tunnels [plan|install|doctor|remove|left]"), 2;
  if (mode === "remove" || mode === "left") return sshTunnels(mode, { home: homedir(), devboxes: [], dialsHub: [], relayPort: 0, hosts: "/etc/hosts", run, print: (line) => console.log(line) });
  const alias = stringSetting("hub.alias");
  return sshTunnels(mode as TunnelMode, {
    home: homedir(), devboxes: tunnelTargets(alias, peerMachine().devboxes, hostname()), dialsHub: profileDevboxes(Bun.env), relayPort: numberSetting("hub.relayPort"),
    httpsHost: optionalStringSetting("hub.httpsHost"), proxy: proxyOn(Bun.env), hosts: "/etc/hosts", run, print: (line) => console.log(line),
  });
}, "fleet ssh-tunnels", failedExit(Bun.argv[2]));
