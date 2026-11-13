import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { declaredUpstreams } from "./declared.ts";
import { loopbackSignedIn } from "./loopback.ts";
import { browserGatewayUrl, gatewayGroup, gatewayPort, isGatewayUrl, localGatewayUrl, refuseLinks, writePrivateFile, type Fetch, type GatewaySettings } from "./client.ts";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Run = (command: string[], options?: { cwd?: string; input?: string; timeoutMs?: number }) => Promise<RunResult>;

export type Hub = {
  home: string;
  root: string;
  platform: NodeJS.Platform;
  uid: number;
  gid: number;
  hubName: () => string;
  gateway: GatewaySettings;
  run: Run;
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  print: (line: string) => void;
};

type BearerKey = { id: string; name?: string; token: string; enabled: boolean; accessType?: string; allowedGroups?: string[] };
type ServerSettings = { type?: string; command?: string; startOnDemand?: boolean; oauth?: { pendingAuthorization?: { authorizationUrl?: string } } };
type McpHubSettings = { mcpServers: Record<string, ServerSettings>; systemConfig: { install: { baseUrl: string } }; bearerKeys: BearerKey[] };

export type Container = { Config: { Labels?: Record<string, string>; Env?: string[] }; Image: string; State: { Running: boolean }; Mounts?: Array<{ Source?: string; Destination: string }> };

export const container = "fleet-mcphub";
const loopback = "http://127.0.0.1:3317";
const secret = () => randomBytes(32).toString("base64url");

export const dataDir = (home: string) => join(home, ".local/share/fleet-mcphub");
const settingsPath = (home: string) => join(dataDir(home), "data/mcp_settings.json");

export async function must(hub: Pick<Hub, "run">, command: string[], options?: { cwd?: string; input?: string }) {
  const result = await hub.run(command, options);
  if (result.code) throw new Error(`${command[0]} ${command[1]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export async function ownedContainer(hub: Pick<Hub, "run">) {
  const inspection = await hub.run(["docker", "container", "inspect", container]);
  const current = inspection.code === 0 ? (JSON.parse(inspection.stdout) as Container[])[0] : undefined;
  if (current && current.Config.Labels?.["org.fleet.service"] !== "mcphub") throw new Error(`Keep unmanaged Docker container ${container}. Review it before installation.`);
  return current;
}

async function reconcilePrivateFile(path: string, next: (existing: string | undefined) => string) {
  const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  const content = next(existing);
  if (content === existing) await chmod(path, 0o600);
  else await writePrivateFile(path, content);
}

function settingsFor(existing: string | undefined, baseUrl: string) {
  if (existing === undefined) {
    return `${JSON.stringify({
      mcpServers: {},
      users: [],
      systemConfig: { install: { baseUrl }, routing: { enableBearerAuth: true, skipAuth: false }, oauthServer: { enabled: false } },
      bearerKeys: [{ id: "fleet-management", name: "Fleet local management", token: secret(), enabled: true, kind: "system", accessType: "all" }],
      prompts: [],
      resources: [],
    }, null, 2)}\n`;
  }
  const settings = JSON.parse(existing) as { systemConfig?: { install?: { baseUrl?: string } } };
  if (settings.systemConfig?.install?.baseUrl === baseUrl) return existing;
  settings.systemConfig = { ...settings.systemConfig, install: { ...settings.systemConfig?.install, baseUrl } };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function environmentFor(existing: string | undefined, baseUrl: string) {
  const values = new Map((existing ?? "").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  for (const name of ["JWT_SECRET", "ADMIN_PASSWORD"]) if (!values.get(name)) values.set(name, secret());
  for (const [name, value] of Object.entries({ MCPHUB_SETTING_PATH: "/app/data/mcp_settings.json", BASE_PATH: "/mcphub", INSTALL_BASE_URL: baseUrl, NODE_ENV: "production" })) values.set(name, value);
  return [...values].map(([name, value]) => `${name}=${value}\n`).join("");
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
  await reconcilePrivateFile(settings, (existing) => settingsFor(existing, baseUrl));
  await reconcilePrivateFile(environment, (existing) => environmentFor(existing, baseUrl));
  return { directory, settings, environment };
}

async function readSettings(home: string): Promise<McpHubSettings | undefined> {
  try { return JSON.parse(await readFile(settingsPath(home), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function installedSettings(hub: Hub) {
  const settings = await readSettings(hub.home);
  if (!settings) throw new Error("MCPHub is not installed. Run: fleet apply");
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

export type Api = ReturnType<typeof api>;

export async function managementApi(hub: Hub) {
  return api(hub, await installedSettings(hub));
}
type Group = { id: string; name: string; servers: Array<string | ({ name: string; tools?: string[] | "all"; pinnedTools?: string[] } & Record<string, unknown>)> };

type ServerState = { name: string; status: string; tools?: unknown[]; error?: string | null; enabled?: boolean };

async function groupGap(call: Api) {
  const servers = (await call<ServerState[]>("servers"));
  const group = (await call<Group[]>("groups")).find((item) => item.name === gatewayGroup);
  const members = new Set((group?.servers ?? []).map((server) => (typeof server === "string" ? server : server.name)));
  return { servers, group, missing: servers.map((server) => server.name).filter((name) => !members.has(name)) };
}

type Entry = Group["servers"][number];
const entryName = (entry: Entry) => (typeof entry === "string" ? entry : entry.name);

function narrowed(entry: Entry, tools: string[]): Entry {
  const kept = typeof entry === "string" ? { name: entry } : entry;
  return { ...kept, tools, ...(kept.pinnedTools && { pinnedTools: kept.pinnedTools.filter((tool) => tools.includes(tool)) }) };
}

/** Puts every server into the Fleet group, and narrows the entry of each declared upstream with an allowlist to its tools. */
export async function syncGatewayGroup(call: Api, home: string) {
  const tools = new Map((await declaredUpstreams(home)).flatMap((upstream) => (upstream.kind === "oauth" && upstream.tools ? [[upstream.name, upstream.tools] as const] : [])));
  const { servers, group, missing } = await groupGap(call);
  const entry = (server: Entry): Entry => {
    const allowed = tools.get(entryName(server));
    return allowed ? narrowed(server, allowed) : server;
  };
  if (!group) return void (await call("groups", "POST", { name: gatewayGroup, description: "Every server, for Fleet's machine keys", servers: servers.map((server) => entry(server.name)) }));
  const kept = group.servers.map(entry);
  if (missing.length || kept.some((server, index) => !Bun.deepEquals(server, group.servers[index]))) await call(`groups/${encodeURIComponent(group.id)}`, "PUT", { servers: [...kept, ...missing.map(entry)] });
}

export async function syncWhenReady(hub: Hub) {
  const call = api(hub, await installedSettings(hub));
  for (let attempt = 1; ; attempt++) {
    try { return await syncGatewayGroup(call, hub.home); }
    catch (error) { if (attempt === 30) throw error; await hub.sleep(500); }
  }
}

/** Finds or makes the gateway key of one machine, and returns its token. */
export async function issueKey(machine: string, hub: Hub) {
  const settings = await installedSettings(hub);
  const call = api(hub, settings);
  await syncGatewayGroup(call, hub.home);
  const name = `Fleet ${machine}`;
  let key = settings.bearerKeys.find((item) => item.name === name && item.enabled);
  if (!key) key = await call<BearerKey>("auth/keys", "POST", { name, kind: "system", accessType: "groups", allowedGroups: [gatewayGroup] });
  else if (key.accessType !== "groups" || !key.allowedGroups?.includes(gatewayGroup)) {
    await call(`auth/keys/${encodeURIComponent(key.id)}`, "PUT", { accessType: "groups", allowedGroups: [gatewayGroup], allowedServers: [] });
  }
  return key.token;
}

const sleepsBetweenCalls = (config: ServerSettings | undefined) => config?.startOnDemand === true && (config.type === "stdio" || (!config.type && Boolean(config.command)));
const sleeping = (server: ServerState, config: ServerSettings | undefined) => server.status === "disconnected" && !server.error && server.enabled !== false && sleepsBetweenCalls(config);
const shownStatus = (server: ServerState, config: ServerSettings | undefined) => (sleeping(server, config) ? "idle (on demand)" : server.status);

export async function doctor(hub: Hub): Promise<boolean> {
  const settings = await readSettings(hub.home);
  if (!settings) return hub.print("MCPHub is not installed. Run: fleet apply"), false;
  const wanted = browserGatewayUrl(hub.gateway);
  if (settings.systemConfig.install.baseUrl !== wanted) return hub.print(`MCPHub answers at ${settings.systemConfig.install.baseUrl}, not ${wanted}. Run: fleet apply`), false;
  const health = await hub.fetch(`${loopback}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  if (!health?.ok) return hub.print("MCPHub does not answer on 127.0.0.1:3317. Run: fleet mcp-gateway restart"), false;
  const open = await hub.fetch(`${localGatewayUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) });
  let ok = open.status === 401;
  if (!ok) hub.print("MCPHub accepts calls without a key. Check routing.skipAuth in its settings.");
  hub.print(`MCPHub dashboard: ${settings.systemConfig.install.baseUrl}/`);
  const { servers, missing } = await groupGap(api(hub, settings));
  for (const server of servers) hub.print(`${server.name}: ${shownStatus(server, settings.mcpServers[server.name])}, ${server.tools?.length ?? 0} tools`);
  if (missing.length) ok = false, hub.print(`The ${gatewayGroup} group lacks ${missing.join(", ")}. Run: fleet apply`);
  return ok;
}

export async function reconnect(server: string, hub: Hub) {
  const settings = await installedSettings(hub);
  if (!Object.hasOwn(settings.mcpServers, server)) throw new Error(`Name a configured upstream server: ${Object.keys(settings.mcpServers).join(", ")}.`);
  await api(hub, settings)(`servers/${encodeURIComponent(server)}/reload`, "POST");
  hub.print(`MCPHub reconnected ${server}. If it needs a sign-in, run: fleet mcp-gateway sign-in`);
}

export async function signIn(hub: Hub) {
  const settings = await installedSettings(hub);
  const byHand = new Set((await declaredUpstreams(hub.home)).flatMap((upstream) => (upstream.kind === "oauth" && upstream.loopback ? [upstream.name] : [])));
  const handWaiting = [...byHand].filter((name) => settings.mcpServers[name] && !loopbackSignedIn(settings.mcpServers[name] as Record<string, unknown>));
  const waiting = Object.entries(settings.mcpServers).flatMap(([name, config]) => (!byHand.has(name) && config.oauth?.pendingAuthorization?.authorizationUrl ? [[name, config.oauth.pendingAuthorization.authorizationUrl] as const] : []));
  if (!waiting.length && !handWaiting.length) return hub.print("No upstream server waits for a sign-in.");
  for (const name of handWaiting) hub.print(`${name}: on the hub, run: fleet mcp-gateway sign-in ${name}`);
  if (!waiting.length) return;
  hub.print(`On your computer, keep this running while you sign in: coder port-forward ${hub.hubName().replace(/^coder\./, "")} --tcp ${gatewayPort}`);
  for (const [name, url] of waiting) hub.print(`${name}: ${url}`);
}

export async function restart(hub: Hub) {
  if (!(await ownedContainer(hub))) throw new Error("MCPHub is not installed. Run: fleet apply");
  await must(hub, ["docker", "restart", container]);
  hub.print("MCPHub restarted. Upstream sign-ins stay on disk.");
}
