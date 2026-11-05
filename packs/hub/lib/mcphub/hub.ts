import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devboxGatewayUrl, gatewayGroup, isGatewayUrl, localGatewayUrl, refuseLinks, saveGatewayClient, type Fetch, type GatewaySettings } from "./client.ts";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Run = (command: string[], options?: { cwd?: string; input?: string }) => Promise<RunResult>;

export type Hub = {
  home: string;
  root: string;
  platform: NodeJS.Platform;
  uid: number;
  gid: number;
  alias: () => string;
  devboxes: () => Promise<string[]>;
  gateway: GatewaySettings;
  run: Run;
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  print: (line: string) => void;
};

type BearerKey = { id: string; name?: string; token: string; enabled: boolean; accessType?: string; allowedGroups?: string[] };
type McpHubSettings = { mcpServers: Record<string, { oauth?: { pendingAuthorization?: { authorizationUrl?: string } } }>; systemConfig: { install: { baseUrl: string } }; bearerKeys: BearerKey[] };

const loopback = "http://127.0.0.1:3317";
const acceptCommand = 'sh "${FLEET_ENGINE_DIR:-$HOME/.local/share/fleet/engine}/fleet" mcphub accept';
const secret = () => randomBytes(32).toString("base64url");

export const dataDir = (home: string) => join(home, ".local/share/fleet-mcphub");
const settingsPath = (home: string) => join(dataDir(home), "data/mcp_settings.json");

export async function must(hub: Pick<Hub, "run">, command: string[], options?: { cwd?: string; input?: string }) {
  const result = await hub.run(command, options);
  if (result.code) throw new Error(`${command[0]} ${command[1]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export async function requireHub(hub: Pick<Hub, "home">, mode: string) {
  const machine = await readFile(join(hub.home, ".config/fleet/machine.json"), "utf8").then((text) => JSON.parse(text) as { role?: string }, () => undefined);
  if (machine?.role !== "hub") throw new Error(`Run fleet mcphub ${mode} on the hub.`);
}

async function createPrivateFile(path: string, content: string) {
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await chmod(path, 0o600);
}

export async function prepareMcpHub(home: string, baseUrl: string, gateway: GatewaySettings) {
  if (!isGatewayUrl(baseUrl, gateway)) throw new Error(`The MCPHub address must be the hub's HTTPS address or ${localGatewayUrl}`);
  const directory = dataDir(home);
  for (const target of [settingsPath(home), join(directory, "runtime.env"), join(directory, "logs")]) await refuseLinks(home, target, "MCPHub path");
  for (const path of [directory, join(directory, "data"), join(directory, "logs")]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  const settings = settingsPath(home);
  const environment = join(directory, "runtime.env");
  await createPrivateFile(settings, `${JSON.stringify({
    mcpServers: {},
    users: [],
    systemConfig: { install: { baseUrl }, routing: { enableBearerAuth: true, skipAuth: false }, oauthServer: { enabled: false } },
    bearerKeys: [{ id: "fleet-management", name: "Fleet local management", token: secret(), enabled: true, kind: "system", accessType: "all" }],
    prompts: [],
    resources: [],
  }, null, 2)}\n`);
  await createPrivateFile(environment, `JWT_SECRET=${secret()}\nADMIN_PASSWORD=${secret()}\nMCPHUB_SETTING_PATH=/app/data/mcp_settings.json\nBASE_PATH=/mcphub\nINSTALL_BASE_URL=${baseUrl}\nNODE_ENV=production\n`);
  return { directory, settings, environment };
}

async function readSettings(home: string): Promise<McpHubSettings | undefined> {
  try { return JSON.parse(await readFile(settingsPath(home), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function installedSettings(hub: Hub) {
  const settings = await readSettings(hub.home);
  if (!settings) throw new Error("MCPHub is not installed. Run: fleet mcphub install");
  return settings;
}

function api(hub: Hub, settings: McpHubSettings) {
  const token = settings.bearerKeys.find((key) => key.id === "fleet-management")?.token;
  return async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await hub.fetch(`${loopback}/mcphub/api/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`MCPHub API ${method} ${path.split("/")[0]} failed with HTTP ${response.status}`);
    return ((await response.json()) as { data: T }).data;
  };
}

type Api = ReturnType<typeof api>;
type Group = { id: string; name: string; servers: Array<string | { name: string }> };

async function groupGap(call: Api) {
  const servers = (await call<Array<{ name: string; status: string; tools?: unknown[] }>>("servers"));
  const group = (await call<Group[]>("groups")).find((item) => item.name === gatewayGroup);
  const members = new Set((group?.servers ?? []).map((server) => (typeof server === "string" ? server : server.name)));
  return { servers, group, missing: servers.map((server) => server.name).filter((name) => !members.has(name)) };
}

export async function syncGatewayGroup(call: Api) {
  const { servers, group, missing } = await groupGap(call);
  const names = servers.map((server) => server.name);
  if (!group) await call("groups", "POST", { name: gatewayGroup, description: "Every server, for Fleet's machine keys", servers: names });
  else if (missing.length) await call(`groups/${encodeURIComponent(group.id)}`, "PUT", { servers: names });
}

export async function syncWhenReady(hub: Hub) {
  const call = api(hub, await installedSettings(hub));
  for (let attempt = 1; ; attempt++) {
    try { return await syncGatewayGroup(call); }
    catch (error) { if (attempt === 30) throw error; await hub.sleep(500); }
  }
}

export async function grant(machine: string, hub: Hub) {
  await requireHub(hub, "grant");
  const alias = hub.alias();
  const devboxes = await hub.devboxes();
  if (machine !== alias && !devboxes.includes(machine)) throw new Error(`Name the hub (${alias}) or a devbox from your profile: ${devboxes.join(", ") || "none"}.`);
  const settings = await installedSettings(hub);
  const call = api(hub, settings);
  await syncGatewayGroup(call);
  const name = `Fleet ${machine}`;
  let key = settings.bearerKeys.find((item) => item.name === name && item.enabled);
  if (!key) key = await call<BearerKey>("auth/keys", "POST", { name, kind: "system", accessType: "groups", allowedGroups: [gatewayGroup] });
  else if (key.accessType !== "groups" || !key.allowedGroups?.includes(gatewayGroup)) {
    await call(`auth/keys/${encodeURIComponent(key.id)}`, "PUT", { accessType: "groups", allowedGroups: [gatewayGroup], allowedServers: [] });
  }
  if (machine === alias) await saveGatewayClient(hub.home, { baseUrl: localGatewayUrl, token: key.token }, hub.gateway);
  else {
    const result = await hub.run(["ssh", machine, acceptCommand], { input: JSON.stringify({ baseUrl: devboxGatewayUrl(hub.gateway), token: key.token }) });
    if (result.code) throw new Error(`${machine} could not save its MCP gateway key: ${result.stderr.trim()}. Run fleet apply on ${machine} first.`);
  }
  hub.print(`${machine}: saved its MCP gateway key.`);
}

export async function doctor(hub: Hub): Promise<boolean> {
  await requireHub(hub, "doctor");
  const settings = await readSettings(hub.home);
  if (!settings) return hub.print("MCPHub is not installed. Run: fleet mcphub install"), false;
  const health = await hub.fetch(`${loopback}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  if (!health?.ok) return hub.print("MCPHub does not answer on 127.0.0.1:3317. Run: fleet mcphub restart"), false;
  const open = await hub.fetch(`${localGatewayUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) });
  let ok = open.status === 401;
  if (!ok) hub.print("MCPHub accepts calls without a key. Check routing.skipAuth in its settings.");
  hub.print(`MCPHub dashboard: ${settings.systemConfig.install.baseUrl}/`);
  const { servers, missing } = await groupGap(api(hub, settings));
  for (const server of servers) hub.print(`${server.name}: ${server.status}, ${server.tools?.length ?? 0} tools`);
  if (missing.length) ok = false, hub.print(`The ${gatewayGroup} group lacks ${missing.join(", ")}. Run: fleet mcphub install`);
  return ok;
}

export async function reconnect(server: string, hub: Hub) {
  await requireHub(hub, "reconnect");
  const settings = await installedSettings(hub);
  if (!Object.hasOwn(settings.mcpServers, server)) throw new Error(`Name a configured upstream server: ${Object.keys(settings.mcpServers).join(", ")}.`);
  await api(hub, settings)(`servers/${encodeURIComponent(server)}/reload`, "POST");
  hub.print(`MCPHub reconnected ${server}. If it needs a sign-in, run: fleet mcphub links`);
}

export async function links(hub: Hub) {
  await requireHub(hub, "links");
  const settings = await installedSettings(hub);
  const signin = join(dataDir(hub.home), "signin");
  await mkdir(signin, { recursive: true, mode: 0o700 });
  for (const [name, config] of Object.entries(settings.mcpServers)) {
    const url = config.oauth?.pendingAuthorization?.authorizationUrl;
    if (!url) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid upstream server name: ${name}`);
    const page = `<!doctype html><meta charset="utf-8"><title>Authorize ${name}</title><script>location.replace(${JSON.stringify(url).replaceAll("<", "\\u003c")})</script>`;
    await writeFile(join(signin, `${name}.html`), page, { mode: 0o600 });
    hub.print(`${name}: ${new URL(`/mcphub-signin/${name}.html`, settings.systemConfig.install.baseUrl)}`);
  }
}

export async function restart(hub: Hub) {
  await requireHub(hub, "restart");
  await must(hub, ["docker", "restart", "fleet-mcphub"]);
  hub.print("MCPHub restarted. Upstream sign-ins stay on disk.");
}
