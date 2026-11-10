import { randomBytes } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { cliProxy, type Agent, type ProxyMode, type Release } from "../lib/cli-proxy.ts";
import { peerMachine, proxyOn } from "../lib/machine.ts";
import { run } from "../lib/run.ts";
import { tunnelTargets } from "../lib/tunnels.ts";
import { numberSetting, stringSetting } from "../../base/lib/settings.ts";

const modes = ["plan", "install", "doctor", "connect", "disconnect", "check"];
const version = "8.0.46";
const archives: Record<string, [string, string]> = {
  x64: ["linux_amd64", "471f5235c501c19d3dec85c06e7612f0fe5ce3f823ef75331c2097aad8ed3c62"],
  arm64: ["linux_aarch64", "07b792e0d2eedb46fcb6c9d1eda913b4c53413076a03199346a85a573fd00de7"],
};

function release(): Release {
  const [asset, sha256] = archives[process.arch] ?? ["unsupported", ""];
  return { version, url: `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}/CLIProxyAPI_${version}_${asset}.tar.gz`, sha256 };
}

await runCommand(() => {
  const [mode = "plan", ...rest] = Bun.argv.slice(2);
  const agent = mode === "check" && rest.length === 1 && rest[0] === "codex" ? "codex" : rest.length ? undefined : "claude";
  if (!agent || !modes.includes(mode)) return console.error("Usage: fleet cli-proxy [plan|install|doctor|check [codex]|disconnect], or fleet cli-proxy connect < key file"), 2;
  return cliProxy(mode as ProxyMode, {
    home: homedir(), uid: process.getuid?.() ?? 0, user: userInfo().username, ...(proxyOn(Bun.env) ? { accounts: numberSetting("hub.proxyAccounts") } : {}),
    devboxes: mode === "doctor" ? tunnelTargets(stringSetting("hub.alias"), peerMachine().devboxes, hostname()) : [],
    release: release(), run, fetch, sleep: (ms) => Bun.sleep(ms), readStdin: () => Bun.stdin.text(), randomKey: () => randomBytes(32).toString("hex"), print: (line) => console.log(line),
  }, agent as Agent);
}, "fleet cli-proxy");
