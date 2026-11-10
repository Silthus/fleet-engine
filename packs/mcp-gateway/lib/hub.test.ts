import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../../src/testing/git.ts";
import { clientPath, localGatewayUrl } from "./client.ts";
import { doctor, grant, links, prepareMcpHub, reconnect, restart } from "./hub.ts";
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

test("grant refuses to run anywhere but the hub, and names the machines it accepts", async () => {
  const devbox = temp.make("fleet-mcphub-");
  writeMachineFile(devbox, "devbox");
  await expect(grant("box-1", fakeHub(devbox))).rejects.toThrow("Run fleet mcphub grant on the hub.");
  await expect(grant("stranger", fakeHub(hubHome()))).rejects.toThrow("Name the hub (my-hub) or a devbox from your profile: box-1, box-2.");
});

test("grant on the hub itself writes a loopback key file directly, scoped to the fleet group of every server", async () => {
  const home = hubHome();
  const api = fakeMcpHub();
  const { calls, run } = fakeRun();
  const hub = fakeHub(home, { fetch: mcphubFetch(api), run });
  await grant("my-hub", hub);
  expect(calls).toEqual([]);
  expect(JSON.parse(readFileSync(clientPath(home), "utf8"))).toEqual({ baseUrl: localGatewayUrl, token: "mcphub_new-machine-token" });
  expect(statSync(clientPath(home)).mode & 0o777).toBe(0o600);
  expect(api.groups).toEqual([{ id: "group-1", name: "fleet", servers: ["tickets", "calendar"] }]);
  expect(api.calls.find((call) => call.path === "auth/keys")?.body).toEqual({ name: "Fleet my-hub", kind: "system", accessType: "groups", allowedGroups: ["fleet"] });
  expect(hub.printed).toEqual(["my-hub: saved its MCP gateway key."]);
});

test("grant sends a devbox its key over SSH on stdin, never in argv, always with the tunnel address, even when the hub has an HTTPS host", async () => {
  for (const [gateway, baseUrl] of [[secure, localGatewayUrl], [{ relayPort: 60001 }, localGatewayUrl]] as const) {
    const home = hubHome();
    const { calls, run } = fakeRun();
    await grant("box-1", fakeHub(home, { run, gateway }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toEqual(["ssh", "box-1", "sh \"${FLEET_ENGINE_DIR:-$HOME/.local/share/fleet/engine}/fleet\" mcphub accept"]);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ baseUrl, token: "mcphub_new-machine-token" });
  }
});

test("grant reuses a machine's key, moves an old server-scoped key to the fleet group, and syncs the group", async () => {
  const oldKey = { id: "key-old", name: "Fleet box-2", token: "mcphub_old-token", enabled: true, kind: "system", accessType: "servers", allowedServers: ["tickets"] };
  const home = hubHome({ bearerKeys: [{ id: "fleet-management", token: managementToken, enabled: true, kind: "system", accessType: "all" }, oldKey] });
  const api = fakeMcpHub({ servers: ["tickets", "calendar", "notes"], groups: [{ id: "group-9", name: "fleet", servers: ["tickets"] }] });
  const { calls, run } = fakeRun();
  await grant("box-2", fakeHub(home, { fetch: mcphubFetch(api), run }));
  expect(api.groups).toEqual([{ id: "group-9", name: "fleet", servers: ["tickets", "calendar", "notes"] }]);
  expect(api.calls.filter((call) => call.method !== "GET")).toEqual([
    { method: "PUT", path: "groups/group-9", body: { servers: ["tickets", "calendar", "notes"] } },
    { method: "PUT", path: "auth/keys/key-old", body: { accessType: "groups", allowedGroups: ["fleet"], allowedServers: [] } },
  ]);
  expect(JSON.parse(calls[0]!.input!).token).toBe("mcphub_old-token");
});

test("grant says when a devbox could not save its key", async () => {
  const { run } = fakeRun(() => ({ code: 127, stderr: "sh: fleet: not found" }));
  await expect(grant("box-1", fakeHub(hubHome(), { run }))).rejects.toThrow("box-1 could not save its MCP gateway key: sh: fleet: not found. Run fleet apply on box-1 first.");
});

test("doctor passes a healthy gateway that refuses calls without a key and serves every server to the fleet group", async () => {
  const api = fakeMcpHub({ groups: [{ id: "group-1", name: "fleet", servers: ["tickets", "calendar"] }] });
  const hub = fakeHub(hubHome(), { fetch: mcphubFetch(api) });
  expect(await doctor(hub)).toBe(true);
  expect(hub.printed).toEqual(["MCPHub dashboard: http://127.0.0.1:3317/mcphub/", "tickets: connected, 2 tools", "calendar: connected, 2 tools"]);
});

test("doctor fails, saying what to run, when MCPHub is missing, down, open, or its fleet group lacks a server", async () => {
  const missing = fakeHub(temp.make("fleet-mcphub-"));
  writeMachineFile(missing.home, "hub");
  expect(await doctor(missing)).toBe(false);
  expect(missing.printed).toEqual(["MCPHub is not installed. Run: fleet mcphub install"]);
  const cases = [
    [fakeMcpHub({ healthy: false }), "MCPHub does not answer on 127.0.0.1:3317. Run: fleet mcphub restart"],
    [fakeMcpHub({ openWithoutKey: true, groups: [{ id: "g", name: "fleet", servers: ["tickets", "calendar"] }] }), "MCPHub accepts calls without a key. Check routing.skipAuth in its settings."],
    [fakeMcpHub({ groups: [{ id: "g", name: "fleet", servers: ["tickets"] }] }), "The fleet group lacks calendar. Run: fleet mcphub install"],
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
  expect(hub.printed).toEqual(["MCPHub reconnected tickets. If it needs a sign-in, run: fleet mcphub links"]);
});

test("links writes a private redirect page for each pending sign-in and prints its address", async () => {
  const pending = { oauth: { pendingAuthorization: { authorizationUrl: "https://auth.example.com/authorize?state=<x>" } } };
  const home = hubHome({ mcpServers: { tickets: pending, "calendar": {} }, systemConfig: { install: { baseUrl: secureUrl } } });
  const hub = fakeHub(home);
  await links(hub);
  const page = join(home, ".local/share/fleet-mcphub/signin/tickets.html");
  expect(readFileSync(page, "utf8")).toBe('<!doctype html><meta charset="utf-8"><title>Authorize tickets</title><script>location.replace("https://auth.example.com/authorize?state=\\u003cx>")</script>');
  expect(statSync(page).mode & 0o777).toBe(0o600);
  expect(hub.printed).toEqual(["tickets: https://hub.internal.example.com:60001/mcphub-signin/tickets.html"]);
});

test("links refuses a linked sign-in page or a linked sign-in folder, and leaves their targets alone", async () => {
  const pending = { oauth: { pendingAuthorization: { authorizationUrl: "https://auth.example.com/authorize" } } };
  const page = (home: string) => join(home, ".local/share/fleet-mcphub/signin/tickets.html");
  const linkedPage = hubHome({ mcpServers: { tickets: pending } });
  const target = join(linkedPage, "target");
  writeFileSync(target, "keep");
  mkdirSync(join(page(linkedPage), ".."));
  symlinkSync(target, page(linkedPage));
  await expect(links(fakeHub(linkedPage))).rejects.toThrow("linked");
  expect(readFileSync(target, "utf8")).toBe("keep");
  const linkedFolder = hubHome({ mcpServers: { tickets: pending } });
  const outside = join(linkedFolder, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(page(linkedFolder), ".."));
  await expect(links(fakeHub(linkedFolder))).rejects.toThrow("linked");
  expect(existsSync(join(outside, "tickets.html"))).toBe(false);
});

test("links replaces an old sign-in page with a new private file", async () => {
  const pending = { oauth: { pendingAuthorization: { authorizationUrl: "https://auth.example.com/authorize?state=new" } } };
  const home = hubHome({ mcpServers: { tickets: pending } });
  const page = join(home, ".local/share/fleet-mcphub/signin/tickets.html");
  mkdirSync(join(page, ".."));
  writeFileSync(page, "old");
  chmodSync(page, 0o644);
  linkSync(page, join(home, "old-page"));
  await links(fakeHub(home));
  expect(readFileSync(join(home, "old-page"), "utf8")).toBe("old");
  expect(readFileSync(page, "utf8")).toContain("state=new");
  expect(statSync(page).mode & 0o777).toBe(0o600);
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
