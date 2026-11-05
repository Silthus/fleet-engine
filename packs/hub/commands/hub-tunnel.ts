import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { numberSetting, optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import { hubTunnel, type MacTunnelMode } from "../lib/hub-tunnel.ts";
import { run } from "../lib/run.ts";

const modes = ["plan", "install", "doctor", "remove"];

await runCommand(() => {
  const [mode = "plan", ...rest] = Bun.argv.slice(2);
  if (rest.length || !modes.includes(mode)) return console.error("Usage: fleet hub-tunnel [plan|install|doctor|remove]"), 2;
  const relayPort = numberSetting("hub.relayPort");
  const coder = Bun.which("coder") ?? undefined;
  return hubTunnel(mode as MacTunnelMode, {
    home: homedir(), platform: process.platform, uid: process.getuid?.() ?? 0, alias: stringSetting("hub.alias"), relayPort,
    gateway: { httpsHost: optionalStringSetting("hub.httpsHost"), relayPort }, ...(coder ? { coder } : {}),
    run, fetch, sleep: (ms) => Bun.sleep(ms), print: (line) => console.log(line),
  });
}, "fleet hub-tunnel");
