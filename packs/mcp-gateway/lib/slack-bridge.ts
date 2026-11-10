import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, managementApi, syncGatewayGroup, type Api, type Hub } from "./hub.ts";
import { bridgeFile, codexMount, codexPackage, install } from "./install.ts";

export const slackServer = "slack";
const containerHome = "/app/data/slack-codex";
export const bridgeHome = (home: string) => join(dataDir(home), "data/slack-codex");
export const hubCodex = (home: string) => join(codexPackage(home), "current/bin/codex");

const wanted = {
  type: "stdio",
  command: "node",
  args: [bridgeFile],
  env: { HOME: containerHome, CODEX_HOME: containerHome, FLEET_CODEX_BIN: `${codexMount}/current/bin/codex` },
  startOnDemand: true,
  options: { timeout: 300000 },
};

type Config = Record<string, unknown>;
const exists = (path: string) => stat(path).then(() => true, () => false);
const plain = (value: unknown): value is Config => typeof value === "object" && value !== null && !Array.isArray(value);
const holds = (have: unknown, want: unknown, key = ""): boolean =>
  plain(want) && key !== "env" ? plain(have) && Object.entries(want).every(([name, value]) => holds(have[name], value, name)) : Bun.deepEquals(have, want);
const keeps = (config: Config) => holds(config, wanted);
const ours = (config: Config) => config.command === wanted.command && Bun.deepEquals(config.args, wanted.args);

async function current(call: Api): Promise<Config | undefined> {
  const names = (await call<Array<{ name: string }>>("servers")).map((server) => server.name);
  if (!names.includes(slackServer)) return undefined;
  return (await call<{ config: Config }>(`servers/${slackServer}`)).config;
}

export async function slackBridgeRegistered(hub: Hub) {
  const config = await current(await managementApi(hub));
  return config !== undefined && keeps(config);
}

export async function slackBridgeSignedIn(hub: Pick<Hub, "home">) {
  return exists(join(bridgeHome(hub.home), "auth.json"));
}

export async function registerSlackBridge(hub: Hub) {
  if (!(await exists(hubCodex(hub.home)))) throw new Error("The Slack bridge runs Codex, and this hub has no Codex from Fleet. Run: fleet install-codex");
  const call = await managementApi(hub);
  const theirs = await current(call);
  if (theirs && !ours(theirs)) throw new Error(`Keep the MCP gateway's ${slackServer} server: Fleet did not add it. Remove it in the gateway's dashboard to use the Slack bridge.`);
  await install(hub);
  const config = await current(call);
  await mkdir(bridgeHome(hub.home), { recursive: true, mode: 0o700 });
  await chmod(bridgeHome(hub.home), 0o700);
  if (!config) await call("servers", "POST", { name: slackServer, config: wanted });
  else if (!keeps(config)) await call(`servers/${slackServer}`, "PUT", { config: wanted });
  await syncGatewayGroup(call);
  if (!keeps((await current(call)) ?? {})) throw new Error("The MCP gateway did not keep the Slack bridge's settings. Run: fleet mcp-gateway doctor");
  hub.print("The Slack bridge is in the MCP gateway.");
  if (!(await slackBridgeSignedIn(hub))) hub.print("Sign the Slack bridge in to ChatGPT, with the account whose Slack app it should use. On the hub, run: fleet mcp-gateway slack-bridge sign-in");
}

export async function signInSlackBridge(hub: Hub) {
  if (!(await exists(hubCodex(hub.home)))) throw new Error("The Slack bridge runs Codex, and this hub has no Codex from Fleet. Run: fleet install-codex");
  await mkdir(bridgeHome(hub.home), { recursive: true, mode: 0o700 });
  hub.print("Sign in with the ChatGPT account whose Slack app the bridge should use. This sign-in stays in the bridge's own Codex home.");
  const code = await Bun.spawn([hubCodex(hub.home), "login", "--device-auth"], { env: { ...process.env, CODEX_HOME: bridgeHome(hub.home) }, stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (code || !(await slackBridgeRegistered(hub))) return code;
  await (await managementApi(hub))(`servers/${slackServer}/reload`, "POST");
  hub.print("The Slack bridge is signed in. Agents reach Slack through the gateway now.");
  return 0;
}
