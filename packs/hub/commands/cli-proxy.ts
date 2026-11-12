import { randomBytes } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";
import { failedExit, runCommand } from "../../base/lib/command.ts";
import { cliProxy, type Agent, type AiPlan, type Panel, type ProxyMode, type Release } from "../lib/cli-proxy.ts";
import { panelDays, peerMachine, proxyOn } from "../lib/machine.ts";
import { run } from "../lib/run.ts";
import { tunnelTargets } from "../lib/tunnels.ts";
import { numberSetting, stringSetting } from "../../base/lib/settings.ts";

const modes = ["plan", "install", "doctor", "connect", "disconnect", "check", "remove", "left"];
const plans = ["claude", "codex", "both"];
const version = "8.0.46";
const archives: Record<string, [string, string]> = {
  x64: ["linux_amd64", "471f5235c501c19d3dec85c06e7612f0fe5ce3f823ef75331c2097aad8ed3c62"],
  arm64: ["linux_aarch64", "07b792e0d2eedb46fcb6c9d1eda913b4c53413076a03199346a85a573fd00de7"],
};

const pageVersion = "1.27.3-fleet.1";
const pluginVersion = "0.1.0";
const plugins: Record<string, [string, string]> = {
  x64: ["linux_amd64", "ed9247c71eae7571b8cbd6b088a78ab6c5fe6508670e9602a40dfdbecc0167ee"],
  arm64: ["linux_arm64", "2b10369f585597308c788df7549f21ed0350fcf98c94b60b27e059597d84f5fa"],
};

function release(): Release {
  const [asset, sha256] = archives[process.arch] ?? ["unsupported", ""];
  return { version, url: `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}/CLIProxyAPI_${version}_${asset}.tar.gz`, sha256 };
}

function panel(historyDays: number): Panel {
  const [asset, sha256] = plugins[process.arch] ?? ["unsupported", ""];
  return {
    historyDays,
    page: { version: pageVersion, url: `https://github.com/Silthus/Cli-Proxy-API-Management-Center/releases/download/v${pageVersion}/management.html`, sha256: "a34316ca54bda5b8ef55dadb0ca0f51fc48a84dfc5ad038d4f0aef312ea2ae4d" },
    plugin: { version: pluginVersion, url: `https://github.com/Silthus/cliproxy-quota-ledger/releases/download/v${pluginVersion}/quota-ledger_${pluginVersion}_${asset}.so`, sha256 },
  };
}

await runCommand(() => {
  const [mode = "plan", ...rest] = Bun.argv.slice(2);
  const agent = mode === "check" && rest.length === 1 && rest[0] === "codex" ? "codex" : rest.length ? undefined : "claude";
  if (!agent || !modes.includes(mode)) return console.error("Usage: fleet cli-proxy [plan|install|doctor|check [codex]|disconnect|remove|left], or fleet cli-proxy connect < key file"), 2;
  const days = panelDays(Bun.env);
  return cliProxy(mode as ProxyMode, {
    home: homedir(), uid: process.getuid?.() ?? 0, user: userInfo().username, ...(plans.includes(Bun.env.FLEET_PLAN ?? "") ? { plan: Bun.env.FLEET_PLAN as AiPlan } : {}), ...(proxyOn(Bun.env) ? { accounts: numberSetting("hub.proxyAccounts") } : {}), ...(days === undefined ? {} : { panel: panel(days) }),
    devboxes: mode === "doctor" ? tunnelTargets(stringSetting("hub.alias"), peerMachine().devboxes, hostname()) : [],
    release: release(), run, fetch, now: Date.now, sleep: (ms) => Bun.sleep(ms), readStdin: () => Bun.stdin.text(), randomKey: () => randomBytes(32).toString("hex"), print: (line) => console.log(line),
  }, agent as Agent);
}, "fleet cli-proxy", failedExit(Bun.argv[2]));
