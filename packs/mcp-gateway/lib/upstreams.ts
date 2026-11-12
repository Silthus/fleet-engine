import { chmod, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { builtInApps, type CodexApp, type Upstream } from "./apps.ts";
import { declaredUpstreams } from "./declared.ts";
import { browserGatewayUrl } from "./client.ts";
import { dataDir, managementApi, syncGatewayGroup, type Api, type Hub } from "./hub.ts";
import { bridgeFile, codexMount, codexPackage, gatewayCurrent, install, legacyBridgeFile, localEntry, missingMount, waitingNote } from "./install.ts";
import { handCallback, loopbackClientOf, registerLoopbackClient } from "./loopback.ts";

const account = (app: CodexApp) => `${app.account ?? app.name}-codex`;
export const appHome = (home: string, app: CodexApp) => join(dataDir(home), "data", account(app));
export const hubCodex = (home: string) => join(codexPackage(home), "current/bin/codex");

type Config = Record<string, unknown>;
const exists = (path: string) => stat(path).then(() => true, () => false);
const plain = (value: unknown): value is Config => typeof value === "object" && value !== null && !Array.isArray(value);
const holds = (have: unknown, want: unknown, key = ""): boolean =>
  plain(want) && key !== "env" ? plain(have) && Object.entries(want).every(([name, value]) => holds(have[name], value, name)) : Bun.deepEquals(have, want);

function wanted(upstream: Upstream, hub: Hub): Config {
  if (upstream.kind === "oauth") {
    const oauth = upstream.loopback ? { redirectUri: handCallback, ...(upstream.scopes && { scopes: upstream.scopes }) } : { redirectUri: `${browserGatewayUrl(hub.gateway)}/oauth/callback` };
    return { type: "streamable-http", url: upstream.url, description: marker, startOnDemand: true, oauth };
  }
  if (upstream.kind === "local") return { type: "stdio", command: "node", args: [localEntry(upstream)], description: marker, env: upstream.env ?? {}, startOnDemand: true };
  const home = `/app/data/${account(upstream)}`;
  return {
    type: "stdio",
    command: "node",
    args: [bridgeFile],
    description: marker,
    env: { HOME: home, CODEX_HOME: home, FLEET_CODEX_BIN: `${codexMount}/current/bin/codex`, FLEET_APP: JSON.stringify(upstream) },
    startOnDemand: true,
    options: { timeout: 300000 },
  };
}

const marker = "Added by Fleet";
const ours = (config: Config) => config.description === marker || (config.command === "node" && Array.isArray(config.args) && [bridgeFile, legacyBridgeFile].includes(config.args[0]));

async function current(call: Api, name: string): Promise<Config | undefined> {
  const names = (await call<Array<{ name: string }>>("servers")).map((server) => server.name);
  if (!names.includes(name)) return undefined;
  return (await call<{ config: Config }>(`servers/${encodeURIComponent(name)}`)).config;
}

async function groupServes(call: Api, upstream: Upstream) {
  const tools = upstream.kind === "oauth" ? upstream.tools : undefined;
  const entry = (await call<Array<{ name: string; servers: Array<string | { name: string; tools?: unknown }> }>>("groups"))
    .find((group) => group.name === "fleet")?.servers.find((server) => (typeof server === "string" ? server : server.name) === upstream.name);
  if (!entry) return false;
  return tools === undefined || (typeof entry !== "string" && Bun.deepEquals(entry.tools, tools));
}

export async function upstreamRegistered(hub: Hub, upstream: Upstream) {
  const call = await managementApi(hub);
  const config = await current(call, upstream.name);
  if (!config || !holds(config, wanted(upstream, hub)) || config.enabled === false || !(await groupServes(call, upstream))) return false;
  if (upstream.kind === "oauth" && upstream.loopback && !loopbackClientOf(config)) return false;
  return upstream.kind === "oauth" || gatewayCurrent(hub);
}

const refuseTheirs = (config: Config | undefined, upstream: Upstream) => {
  if (config && !ours(config)) throw new Error(`Keep the MCP gateway's ${upstream.name} server: Fleet did not add it. Remove it in the gateway's dashboard to use ${upstream.title}.`);
};

export const appSignedIn = (hub: Pick<Hub, "home">, app: CodexApp) => exists(join(appHome(hub.home, app), "auth.json"));

export async function registerUpstream(hub: Hub, upstream: Upstream) {
  const codexMissing = `${upstream.title} runs through Codex, and this hub has no Codex from Fleet. Run: fleet install-codex`;
  if (upstream.kind === "codex-app" && !(await exists(hubCodex(hub.home)))) throw new Error(codexMissing);
  const waitsFor = upstream.kind === "local" ? await missingMount(upstream) : undefined;
  if (upstream.kind === "local" && waitsFor) return hub.print(waitingNote(upstream, waitsFor));
  const call = await managementApi(hub);
  refuseTheirs(await current(call, upstream.name), upstream);
  if (upstream.kind !== "oauth") await install(hub);
  const config = await current(call, upstream.name);
  refuseTheirs(config, upstream);
  if (upstream.kind === "codex-app") {
    await mkdir(appHome(hub.home, upstream), { recursive: true, mode: 0o700 });
    await chmod(appHome(hub.home, upstream), 0o700);
  }
  const want = wanted(upstream, hub);
  const path = `servers/${encodeURIComponent(upstream.name)}`;
  const newClient = upstream.kind === "oauth" && upstream.loopback && !loopbackClientOf(config);
  if (newClient) want.oauth = { ...(want.oauth as Config), clientId: await registerLoopbackClient(hub.fetch, upstream) };
  if (!config) await call("servers", "POST", { name: upstream.name, config: want });
  else if (newClient) await call(path, "PUT", { config: { ...config, ...want } });
  else if (!holds(config, want)) await call(path, "PUT", { config: { ...config, ...want, ...(plain(config.oauth) && { oauth: { ...config.oauth, ...(want.oauth as Config) } }) } });
  if (config?.enabled === false) await call(`${path}/toggle`, "POST", { enabled: true });
  await syncGatewayGroup(call, hub.home);
  const kept = (await current(call, upstream.name)) ?? {};
  if (!holds(kept, want) || !(await groupServes(call, upstream))) throw new Error(`The MCP gateway did not keep the settings of ${upstream.title}. Run: fleet mcp-gateway doctor`);
  if (upstream.kind === "oauth") {
    const signIn = upstream.loopback ? (newClient ? `fleet mcp-gateway sign-in ${upstream.name}` : undefined) : config ? undefined : "fleet mcp-gateway sign-in";
    return hub.print(`${upstream.title} is in the MCP gateway.${signIn ? ` To sign in to it, on the hub, run: ${signIn}` : ""}`);
  }
  hub.print(`${upstream.title} is in the MCP gateway.`);
  if (upstream.kind === "local") return;
  if (!(await appSignedIn(hub, upstream))) hub.print(`Sign ${upstream.title} in to ChatGPT, with the account whose ${upstream.title} app it should use. On the hub, run: fleet mcp-gateway sign-in ${upstream.name}`);
}

export async function upstreamsRegistered(hub: Hub) {
  for (const upstream of await declaredUpstreams(hub.home)) if (!(await upstreamRegistered(hub, upstream))) return false;
  return true;
}

export async function registerUpstreams(hub: Hub) {
  for (const upstream of await declaredUpstreams(hub.home)) if (!(await upstreamRegistered(hub, upstream))) await registerUpstream(hub, upstream);
}

export async function codexApps(home: string) {
  return [...builtInApps, ...(await declaredUpstreams(home)).filter((upstream): upstream is CodexApp => upstream.kind === "codex-app")];
}

async function deviceSignIn(hub: Hub, app: CodexApp) {
  const signIns = join(dataDir(hub.home), "sign-in");
  await mkdir(signIns, { recursive: true, mode: 0o700 });
  await mkdir(appHome(hub.home, app), { recursive: true, mode: 0o700 });
  const fresh = await mkdtemp(join(signIns, `${account(app)}-`));
  try {
    const code = await Bun.spawn([hubCodex(hub.home), "login", "--device-auth"], { env: { ...process.env, CODEX_HOME: fresh }, stdio: ["inherit", "inherit", "inherit"] }).exited;
    if (!code) await rename(join(fresh, "auth.json"), join(appHome(hub.home, app), "auth.json"));
    return code;
  } finally { await rm(fresh, { recursive: true, force: true }); }
}

const listsNoTools = async (call: Api, app: CodexApp) => !(await call<{ tools?: unknown[] }>(`servers/${encodeURIComponent(app.name)}`)).tools?.length;

export async function appReady(hub: Hub, app: CodexApp) {
  if (!(await appSignedIn(hub, app))) return false;
  return !(await managementApi(hub).then((call) => listsNoTools(call, app)).catch(() => false));
}

export async function signInApp(hub: Hub, app: CodexApp) {
  if (!(await exists(hubCodex(hub.home)))) throw new Error(`${app.title} runs through Codex, and this hub has no Codex from Fleet. Run: fleet install-codex`);
  hub.print(`Sign in with the ChatGPT account whose ${app.title} app the gateway should use. This sign-in stays in its own Codex home.`);
  const code = await deviceSignIn(hub, app);
  if (code) return code;
  const sharing = (await codexApps(hub.home)).filter((other) => account(other) === account(app));
  const call = await managementApi(hub);
  const reloaded: CodexApp[] = [];
  for (const other of sharing) {
    if (!(await upstreamRegistered(hub, other))) continue;
    await call(`servers/${encodeURIComponent(other.name)}/reload`, "POST");
    reloaded.push(other);
  }
  const toolless: CodexApp[] = [];
  for (const other of reloaded) if (await listsNoTools(call, other).catch(() => false)) toolless.push(other);
  for (const other of toolless) hub.print(`The gateway finds no ${other.title} tools for this sign-in. Connect ${other.title} in ChatGPT, Settings, Apps, with this ChatGPT account, then run: fleet mcp-gateway reconnect ${other.name}`);
  if (toolless.length) return 1;
  hub.print(`${sharing.map((other) => other.title).join(", ")} signed in. Agents reach them through the gateway now.`);
  return 0;
}
