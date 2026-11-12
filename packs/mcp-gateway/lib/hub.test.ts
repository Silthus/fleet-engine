import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { clientPath, localGatewayUrl } from "./client.ts";
import { doctor, issueKey, prepareMcpHub, reconnect, restart, signIn } from "./hub.ts";
import { fakeHub, fakeMcpHub, fakeRun, managementToken, mcphubFetch, writeMachineFile, writeMcpHubSettings } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const secureUrl = "https://hub.internal.example.com:60001/mcphub";
const secure = { httpsHost: "hub.internal.example.com", relayPort: 60001 };

function hubHome(settings?: Record<string, unknown>) {
  const home = temp.make("fleet-mcphub-hub-");
  writeMachineFile(home, "hub");
  writeMcpHubSettings(home, settings);
  return home;
}

test("preparing the hub twice keeps its upstream grants and its service secrets", async () => {
  const home = temp.make("fleet-mcphub-");
  const first = await prepareMcpHub(home, secureUrl, secure);
  const settings = JSON.parse(readFileSync(first.settings, "utf8"));
  expect(settings.mcpServers).toEqual({});
  expect(settings.systemConfig).toEqual({ install: { baseUrl: secureUrl }, routing: { enableBearerAuth: true, skipAuth: false }, oauthServer: { enabled: false } });
  expect(settings.bearerKeys).toEqual([expect.objectContaining({ id: "fleet-management", kind: "system", accessType: "all" })]);
  settings.mcpServers.notes = { type: "streamable-http", url: "https://notes.example.com/mcp", oauth: { refreshToken: "existing-grant" } };
  writeFileSync(first.settings, JSON.stringify(settings));
  const environment = readFileSync(first.environment, "utf8");
  expect(environment).toContain(`INSTALL_BASE_URL=${secureUrl}\n`);
  expect(environment).toMatch(/^JWT_SECRET=[\w-]{43}\nADMIN_PASSWORD=[\w-]{43}\n/);
  await prepareMcpHub(home, secureUrl, secure);
  expect(JSON.parse(readFileSync(first.settings, "utf8")).mcpServers.notes.oauth.refreshToken).toBe("existing-grant");
  expect(readFileSync(first.environment, "utf8")).toBe(environment);
  expect(statSync(first.directory).mode & 0o777).toBe(0o700);
  expect(statSync(first.settings).mode & 0o777).toBe(0o600);
  expect(statSync(first.environment).mode & 0o777).toBe(0o600);
});

test("preparation refuses a linked data folder without touching its target", async () => {
  const home = temp.make("fleet-mcphub-");
  const outside = join(home, "outside");
  mkdirSync(join(home, ".local/share"), { recursive: true });
  mkdirSync(outside);
  const permissions = statSync(outside).mode & 0o777;
  writeFileSync(join(outside, "unmanaged"), "keep");
  symlinkSync(outside, join(home, ".local/share/fleet-mcphub"));
  await expect(prepareMcpHub(home, secureUrl, secure)).rejects.toThrow("linked");
  expect(readFileSync(join(outside, "unmanaged"), "utf8")).toBe("keep");
  expect(statSync(outside).mode & 0o777).toBe(permissions);
});

test("preparation accepts only the hub's HTTPS address or the loopback address as its callback origin", async () => {
  const home = temp.make("fleet-mcphub-");
  for (const url of ["http://hub:60001/mcphub", "https://user:secret@hub.internal.example.com:60001/mcphub", `${secureUrl}?secret=x`, `${secureUrl}\nADMIN_PASSWORD=injected`, "https://hub.internal.example.com:60001/other"]) {
    await expect(prepareMcpHub(home, url, secure)).rejects.toThrow("The MCPHub address must be the hub's HTTPS address or http://127.0.0.1:3317/mcphub");
  }
  await prepareMcpHub(home, localGatewayUrl, { relayPort: 60001 });
});

test("a key comes only from an installed gateway", async () => {
  await expect(issueKey("box-1", fakeHub(temp.make("fleet-mcphub-")))).rejects.toThrow("MCPHub is not installed. Run: fleet apply");
});

test("a new key is scoped to the fleet group, which holds every server", async () => {
  const api = fakeMcpHub();
  expect(await issueKey("my-hub", fakeHub(hubHome(), { fetch: mcphubFetch(api) }))).toBe("mcphub_new-machine-token");
  expect(api.groups).toEqual([{ id: "group-1", name: "fleet", servers: ["tickets", "calendar"] }]);
  expect(api.calls.find((call) => call.path === "auth/keys")?.body).toEqual({ name: "Fleet my-hub", kind: "system", accessType: "groups", allowedGroups: ["fleet"] });
});

test("a machine keeps its key, an old server-scoped key moves to the fleet group, and the group syncs", async () => {
  const oldKey = { id: "key-old", name: "Fleet box-2", token: "mcphub_old-token", enabled: true, kind: "system", accessType: "servers", allowedServers: ["tickets"] };
  const home = hubHome({ bearerKeys: [{ id: "fleet-management", token: managementToken, enabled: true, kind: "system", accessType: "all" }, oldKey] });
  const api = fakeMcpHub({ servers: ["tickets", "calendar", "notes"], groups: [{ id: "group-9", name: "fleet", servers: ["tickets"] }] });
  expect(await issueKey("box-2", fakeHub(home, { fetch: mcphubFetch(api) }))).toBe("mcphub_old-token");
  expect(api.groups).toEqual([{ id: "group-9", name: "fleet", servers: ["tickets", "calendar", "notes"] }]);
  expect(api.calls.filter((call) => call.method !== "GET")).toEqual([
    { method: "PUT", path: "groups/group-9", body: { servers: ["tickets", "calendar", "notes"] } },
    { method: "PUT", path: "auth/keys/key-old", body: { accessType: "groups", allowedGroups: ["fleet"], allowedServers: [] } },
  ]);
});

test("doctor passes a healthy gateway that refuses calls without a key and serves every server to the fleet group", async () => {
  const api = fakeMcpHub({ groups: [{ id: "group-1", name: "fleet", servers: ["tickets", "calendar"] }] });
  const hub = fakeHub(hubHome(), { fetch: mcphubFetch(api) });
  expect(await doctor(hub)).toBe(true);
  expect(hub.printed).toEqual(["MCPHub dashboard: http://127.0.0.1:3317/mcphub/", "tickets: connected, 2 tools", "calendar: connected, 2 tools"]);
});

test("doctor shows a stdio server that starts on demand and sleeps between calls as idle, with the tools it keeps; a failed, turned-off or other server shows its own status", async () => {
  const servers = {
    slack: { status: "disconnected", tools: 21, config: { type: "stdio", command: "node", startOnDemand: true } },
    docs: { status: "disconnected", tools: 3, config: { command: "npx", startOnDemand: true } },
    calendar: { status: "connected", tools: 2, config: { type: "stdio", command: "node", startOnDemand: true } },
    drive: { status: "disconnected", tools: 0, error: "Failed to connect: spawn node ENOENT", config: { type: "stdio", command: "node", startOnDemand: true } },
    mail: { status: "disconnected", tools: 0, enabled: false, config: { type: "stdio", command: "node", startOnDemand: true } },
    notes: { status: "disconnected", tools: 0, config: { type: "streamable-http", url: "https://notes.example.com/mcp", startOnDemand: true } },
    tickets: { status: "disconnected", tools: 2, config: { type: "stdio", command: "node" } },
  };
  const names = Object.keys(servers);
  const gateway = mcphubFetch(fakeMcpHub({ servers: names, groups: [{ id: "g", name: "fleet", servers: names }] }));
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith("/api/servers")) return gateway(input, init);
    return Response.json({ success: true, data: Object.entries(servers).map(([name, { config, tools, ...server }]) => ({ name, ...server, tools: Array.from({ length: tools }, () => ({})) })) });
  };
  const hub = fakeHub(hubHome({ mcpServers: Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, server.config])) }), { fetch });
  expect(await doctor(hub)).toBe(true);
  expect(hub.printed.slice(1)).toEqual([
    "slack: idle (on demand), 21 tools",
    "docs: idle (on demand), 3 tools",
    "calendar: connected, 2 tools",
    "drive: disconnected, 0 tools",
    "mail: disconnected, 0 tools",
    "notes: disconnected, 0 tools",
    "tickets: disconnected, 2 tools",
  ]);
});

test("doctor fails, saying what to run, when MCPHub is missing, down, open, or its fleet group lacks a server", async () => {
  const missing = fakeHub(temp.make("fleet-mcphub-"));
  writeMachineFile(missing.home, "hub");
  expect(await doctor(missing)).toBe(false);
  expect(missing.printed).toEqual(["MCPHub is not installed. Run: fleet apply"]);
  const cases = [
    [fakeMcpHub({ healthy: false }), "MCPHub does not answer on 127.0.0.1:3317. Run: fleet mcp-gateway restart"],
    [fakeMcpHub({ openWithoutKey: true, groups: [{ id: "g", name: "fleet", servers: ["tickets", "calendar"] }] }), "MCPHub accepts calls without a key. Check routing.skipAuth in its settings."],
    [fakeMcpHub({ groups: [{ id: "g", name: "fleet", servers: ["tickets"] }] }), "The fleet group lacks calendar. Run: fleet apply"],
  ] as const;
  for (const [api, line] of cases) {
    const hub = fakeHub(hubHome(), { fetch: mcphubFetch(api) });
    expect(await doctor(hub)).toBe(false);
    expect(hub.printed).toContain(line);
  }
});

test("reconnect reloads only a configured upstream", async () => {
  const api = fakeMcpHub();
  const hub = fakeHub(hubHome(), { fetch: mcphubFetch(api) });
  await expect(reconnect("unknown", hub)).rejects.toThrow("Name a configured upstream server: tickets, calendar.");
  await reconnect("tickets", hub);
  expect(api.calls).toEqual([{ method: "POST", path: "servers/tickets/reload" }]);
  expect(hub.printed).toEqual(["MCPHub reconnected tickets. If it needs a sign-in, run: fleet mcp-gateway sign-in"]);
});

test("sign-in prints the forward for your computer and each pending authorization address, and no page", async () => {
  const pending = { oauth: { pendingAuthorization: { authorizationUrl: "https://auth.example.com/authorize?state=<x>" } } };
  const home = hubHome({ mcpServers: { tickets: pending, calendar: {} } });
  const hub = fakeHub(home);
  await signIn(hub);
  expect(hub.printed).toEqual(["On your computer, keep this running while you sign in: coder port-forward my-hub --tcp 3317", "tickets: https://auth.example.com/authorize?state=<x>"]);
  expect(existsSync(join(home, ".local/share/fleet-mcphub/signin"))).toBe(false);
  const quiet = fakeHub(hubHome());
  await signIn(quiet);
  expect(quiet.printed).toEqual(["No upstream server waits for a sign-in."]);
});

test("sign-in forwards from the hub's Coder workspace when the profile names the hub by its coder.<workspace> SSH name", async () => {
  const pending = { oauth: { pendingAuthorization: { authorizationUrl: "https://auth.example.com/authorize?state=<x>" } } };
  const hub = fakeHub(hubHome({ mcpServers: { tickets: pending } }), { hubName: () => "coder.my-hub" });
  await signIn(hub);
  expect(hub.printed[0]).toBe("On your computer, keep this running while you sign in: coder port-forward my-hub --tcp 3317");
});

const ownContainer = (call: { command: string[] }) => call.command[1] === "container" ? { stdout: JSON.stringify([{ Config: { Labels: { "org.fleet.service": "mcphub" } } }]) } : {};

test("restart restarts the container and keeps the grants on disk", async () => {
  const { calls, run } = fakeRun(ownContainer);
  const hub = fakeHub(hubHome(), { run });
  await restart(hub);
  expect(calls.map((call) => call.command)).toEqual([["docker", "container", "inspect", "fleet-mcphub"], ["docker", "restart", "fleet-mcphub"]]);
  expect(hub.printed).toEqual(["MCPHub restarted. Upstream sign-ins stay on disk."]);
});

test("restart keeps a container named fleet-mcphub that Fleet did not make", async () => {
  const { calls, run } = fakeRun((call) => call.command[1] === "container" ? { stdout: JSON.stringify([{ Config: { Labels: {} } }]) } : {});
  await expect(restart(fakeHub(hubHome(), { run }))).rejects.toThrow("Keep unmanaged Docker container fleet-mcphub. Review it before installation.");
  expect(calls.map((call) => call.command[1])).toEqual(["container"]);
});
