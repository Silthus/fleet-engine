import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { numberSetting, optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import { hubHttps, type HttpsMode } from "../lib/https.ts";
import { run } from "../lib/run.ts";

const modes = ["plan", "install", "doctor", "ca", "trusted"];

await runCommand(() => {
  const [mode = "plan", ...rest] = Bun.argv.slice(2);
  if (rest.length || !modes.includes(mode)) return console.error("Usage: fleet hub-https [plan|install|doctor|ca|trusted]"), 2;
  return hubHttps(mode as HttpsMode, {
    home: homedir(), alias: stringSetting("hub.alias"), httpsHost: optionalStringSetting("hub.httpsHost"), relayPort: numberSetting("hub.relayPort"), user: userInfo().username, uid: process.getuid?.() ?? 0,
    caddyInstalled: () => existsSync("/usr/bin/caddy"), run, sleep: (ms) => Bun.sleep(ms), print: (line) => console.log(line),
  });
}, "fleet hub-https");
