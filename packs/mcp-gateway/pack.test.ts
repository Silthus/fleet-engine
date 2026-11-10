import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerConfigAdapter } from "../../src/adapters/provider-config/adapter.ts";
import { main, type CliOptions } from "../../src/cli.ts";
import type { AvailableSource, MachineFile, Profile } from "../../src/pack/types.ts";
import { filesAdapter } from "../../src/reconciler/apply.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, mac, resolveEngine, skillSources } from "../../src/testing/packs.ts";
import { fakeSsh, remoteFleet, type Host } from "../../src/testing/ssh.ts";
import { fakeMcpHub, mcphubFetch, writeMcpHubSettings } from "./lib/testing.ts";

const temp = tempDirs();
afterEach(() => {
  mock.restore();
  temp.cleanup();
});

const repoRoot = join(import.meta.dir, "../..");
const issued = "mcphub_new-machine-token";
const clientFile = (home: string) => join(home, ".config/fleet/mcphub.client.json");
const storeFile = (home: string) => join(home, ".config/fleet/secrets/mcp-gateway/credential.mcp-gateway");
const gatewayKeys = ["claude:mcpServers.fleet-hub", "codex:mcp_servers.fleet-hub"];

let sources: AvailableSource[];
beforeAll(async () => {
  const engine = await engineSource();
  sources = [engine, ...skillSources(temp.make("skills-"), engine)];
});

describe("the plan", () => {
  const hubAnswers = { "hub.alias": "my-hub" };
  const keys = (fields: Partial<Profile>, machine: MachineFile = devbox) => resolveEngine(sources, { packs: ["mcp-gateway"], ...fields }, machine).config.map((entry) => `${entry.provider}:${entry.key}`).filter((key) => gatewayKeys.includes(key));

  test("every node's catalog holds the hub's gateway at loopback port 3317, and its MCP entries start fleet mcp-connect with no host or key", () => {
    for (const machine of [devbox, mac]) {
      const plan = resolveEngine(sources, { packs: ["mcp-gateway"], hub: "hub-1" }, machine);
      expect(plan.catalog).toEqual([{ pack: "mcp-gateway", id: "mcp-gateway", port: 3317, health: "/health", after: "mcp-gateway-installed" }]);
      expect(plan.human.map((step) => step.id)).toEqual(["mcp-gateway-client"]);
      for (const entry of plan.config.filter((item) => item.pack === "mcp-gateway")) {
        const text = JSON.stringify(entry.value);
        expect(text).toContain('fleet\\" mcp-connect');
        expect(text).not.toMatch(/https?:|token|bearer|authorization|127\.0\.0\.1/i);
      }
    }
  });

  test("gives each plan only its own provider's entry, owned by this pack", () => {
    expect(keys({ plan: "claude" })).toEqual(["claude:mcpServers.fleet-hub"]);
    expect(keys({ plan: "codex" })).toEqual(["codex:mcp_servers.fleet-hub"]);
    expect(keys({}, mac)).toEqual(gatewayKeys);
    const owners = resolveEngine(sources, { packs: ["mcp-gateway"] }, devbox).owners;
    for (const key of gatewayKeys) expect(owners[key]).toBe("mcp-gateway");
  });

  test("a profile that lists the Hub pack keeps the gateway until it turns the mcp-gateway workflow off", () => {
    const hubKeys = (workflows: Record<string, boolean>) => resolveEngine(sources, { packs: ["hub"], settings: hubAnswers, workflows }, devbox).config.filter((entry) => entry.pack === "mcp-gateway").length;
    expect(hubKeys({})).toBe(2);
    expect(hubKeys({ "mcp-gateway": false })).toBe(0);
    expect(resolveEngine(sources, { packs: ["hub", "mcp-gateway"], settings: hubAnswers }, devbox).packs.filter((pack) => pack.name === "mcp-gateway")).toHaveLength(1);
  });
});

function gatewayServer(fields: Parameters<typeof fakeMcpHub>[0] = {}) {
  const state = fakeMcpHub({ groups: [{ id: "g", name: "fleet", servers: ["tickets", "calendar"] }], ...fields });
  const api = mcphubFetch(state);
  const bridged: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname !== "/mcphub/mcp/fleet") return api(input, init);
    const key = new Headers(init.headers).get("authorization");
    bridged.push(`${init.method} ${key}`);
    if (key !== `Bearer ${issued}`) return new Response("Unauthorized", { status: 401 });
    if (init.method !== "POST") return new Response(null, { status: 200 });
    const message = JSON.parse(String(init.body)) as { id: number };
    return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mcphub", version: "1.1.0" } } }, { headers: { "mcp-session-id": "session-1" } });
  }) as typeof fetch);
  const spawned: string[][] = [];
  const spawn = Bun.spawn;
  spyOn(Bun, "spawn").mockImplementation(((command: string[], options: never) => {
    if (command[0] !== "docker") return spawn(command, options);
    spawned.push(command);
    return { exited: Promise.resolve(127), stdout: new Response("").body, stderr: new Response(`${command[0]}: command not found`).body };
  }) as never);
  return { state, bridged, spawned };
}

function machine(saved: MachineFile, fields: Partial<Profile> = {}, hosts: Record<string, Host | "down"> = {}) {
  const home = temp.make("home-");
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["mcp-gateway"], plan: "codex", settings: {}, workflows: {}, hub: "hub-1", devboxes: ["node-2"], ...fields }));
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ ...saved, profileDir: profile }));
  let lines: string[] = [];
  const errors: string[] = [];
  let input = "";
  const options: CliOptions = {
    home,
    engineRoot: repoRoot,
    platform: "linux",
    env: {},
    print: (line) => lines.push(line),
    fail: (line) => errors.push(line),
    hostname: () => saved.name!,
    stdin: () => new Response(input).body!,
    capture: fakeSsh(temp.make("ssh-"), hosts),
    run: async (command) => (command[0] === "/bin/sh" && command[1] === join(repoRoot, "fleet") ? main(command.slice(2), { ...options, print: () => {} }) : 0),
    adapters: () => [filesAdapter, providerConfigAdapter({ run: async () => ({ code: 0, stdout: "" }) })],
  };
  const fleet = async (args: string[], stdin = "") => {
    lines = [];
    input = stdin;
    const code = await main(args, options);
    return { code, output: lines.join("\n") };
  };
  return { home, fleet, errors, host: remoteFleet(() => options) };
}

const initialize = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent", version: "1" } } })}\n`;
const hubMachine: MachineFile = { schema: 1, role: "linux", name: "hub-1" };
const nodeMachine: MachineFile = { schema: 1, role: "devbox", coder: true, name: "node-2" };

describe("on the hub", () => {
  test("apply issues the hub's own key, writes the client file from it, and the bridge reaches the gateway with it", async () => {
    const { home, fleet } = machine(hubMachine);
    writeMcpHubSettings(home);
    const { state, bridged, spawned } = gatewayServer({ home });
    const applied = await fleet(["apply"]);
    expect(applied.code).toBe(0);
    expect(spawned).toEqual([]);
    expect(applied.output).not.toContain("cannot reach the MCP gateway");
    expect(state.calls.find((call) => call.path === "auth/keys")?.body).toEqual({ name: "Fleet hub-1", kind: "system", accessType: "groups", allowedGroups: ["fleet"] });
    expect(readFileSync(storeFile(home), "utf8")).toBe(issued);
    expect(JSON.parse(readFileSync(clientFile(home), "utf8"))).toEqual({ baseUrl: "http://127.0.0.1:3317/mcphub", token: issued });
    expect(statSync(clientFile(home)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toContain("mcp-connect");

    const connected = await fleet(["mcp-connect"], initialize);
    expect(connected.code).toBe(0);
    expect(bridged[0]).toBe(`POST Bearer ${issued}`);
    expect(JSON.parse(connected.output.split("\n")[0]!)).toMatchObject({ id: 1, result: { serverInfo: { name: "mcphub" } } });

    const again = await fleet(["apply"]);
    expect(again.code).toBe(0);
    expect(state.calls.filter((call) => call.path === "auth/keys")).toHaveLength(1);
  });

  test("an apply while the gateway does not answer runs the install repair, issues no key when it fails, and the bridge says to apply on the hub", async () => {
    const { home, fleet } = machine(hubMachine);
    writeMcpHubSettings(home);
    const { spawned } = gatewayServer({ home, healthy: false });
    const applied = await fleet(["apply"]);
    expect(applied.output).toContain("The MCP gateway is not installed on the hub, or does not answer.");
    expect(spawned[0]).toEqual(["docker", "image", "inspect", expect.stringMatching(/^fleet-mcphub:1\.1\.0-/)]);
    expect(existsSync(storeFile(home))).toBe(false);
    const errors: string[] = [];
    spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
    expect(await fleet(["mcp-connect"], initialize)).toEqual({ code: 1, output: "" });
    expect(errors).toEqual(["mcp-gateway/mcp-gateway has no credential on this machine yet. Run fleet apply on the hub."]);
  });

  test("a gateway installed at an HTTPS address fails the install check, and apply reinstalls it at loopback", async () => {
    const { home, fleet } = machine(hubMachine);
    writeMcpHubSettings(home, { systemConfig: { install: { baseUrl: "https://hub.internal.example.com:60001/mcphub" } } });
    const { spawned } = gatewayServer({ home });
    expect(await fleet(["run", "mcp-gateway/mcp-gateway-installed"])).toMatchObject({ code: 1 });
    expect((await fleet(["mcp-gateway", "doctor"])).output).toContain("MCPHub answers at https://hub.internal.example.com:60001/mcphub, not http://127.0.0.1:3317/mcphub. Run: fleet apply");
    await fleet(["apply"]);
    expect(spawned[0]).toEqual(["docker", "image", "inspect", expect.stringMatching(/^fleet-mcphub:1\.1\.0-/)]);
  });

  test("a failure before the bridge starts goes to standard error, never onto the MCP stream", async () => {
    const { home, fleet, errors } = machine(hubMachine);
    mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
    writeFileSync(join(home, ".local/state/fleet/mcp-gateway"), "");
    gatewayServer({ home });
    expect(await fleet(["mcp-connect"], initialize)).toEqual({ code: 1, output: "" });
    expect(errors).toEqual([expect.stringMatching(/^fleet: EEXIST/)]);
  });

  test("sign-in prints the forward for your computer with the profile's hub, and each pending authorization address", async () => {
    const { home, fleet } = machine(hubMachine);
    writeMcpHubSettings(home, { mcpServers: { tickets: { oauth: { pendingAuthorization: { authorizationUrl: "https://auth.example.com/authorize?state=1" } } } } });
    gatewayServer({ home });
    expect(await fleet(["mcp-gateway", "sign-in"])).toEqual({ code: 0, output: "On your computer, keep this running while you sign in: coder port-forward hub-1 --tcp 3317\ntickets: https://auth.example.com/authorize?state=1" });
    expect((await fleet(["mcp-gateway", "sign", "in"])).code).toBe(2);
  });

  test("a solo machine, with no hub in the profile, is its own hub and issues its own key", async () => {
    const { home, fleet } = machine({ schema: 1, role: "linux", name: "only-1" }, { hub: undefined, devboxes: undefined });
    writeMcpHubSettings(home);
    const { state } = gatewayServer({ home });
    expect((await fleet(["apply"])).code).toBe(0);
    expect(state.calls.find((call) => call.path === "auth/keys")?.body).toMatchObject({ name: "Fleet only-1" });
    expect(readFileSync(storeFile(home), "utf8")).toBe(issued);
  });
});

describe("on a devbox", () => {
  test("apply adopts the key that today's client file holds into the store, at loopback or at the hub's old HTTPS address, and the bridge uses it", async () => {
    for (const baseUrl of ["http://127.0.0.1:3317/mcphub", "https://hub.internal.example.com:60001/mcphub"]) {
      const { home, fleet } = machine(nodeMachine);
      writeFileSync(clientFile(home), JSON.stringify({ baseUrl, token: issued }));
      const { bridged } = gatewayServer();
      const applied = await fleet(["apply"]);
      expect(applied.output).not.toContain("cannot reach the MCP gateway");
      expect(readFileSync(storeFile(home), "utf8")).toBe(issued);
      expect(JSON.parse(readFileSync(clientFile(home), "utf8"))).toEqual({ baseUrl: "http://127.0.0.1:3317/mcphub", token: issued });
      expect((await fleet(["mcp-connect"], initialize)).code).toBe(0);
      expect(bridged[0]).toBe(`POST Bearer ${issued}`);
      mock.restore();
    }
  });

  test("apply pulls this machine's key from the hub over ssh, the client file follows the store, and the bridge uses the key", async () => {
    const hub = machine(hubMachine);
    writeMcpHubSettings(hub.home);
    const { state, bridged } = gatewayServer({ home: hub.home });
    expect((await hub.fleet(["apply"])).code).toBe(0);
    const { home, fleet } = machine(nodeMachine, {}, { "hub-1": hub.host });
    const applied = await fleet(["apply"]);
    expect(applied.output).not.toContain("Could not pull");
    expect(state.calls.filter((call) => call.path === "auth/keys").map((call) => call.body)).toEqual([expect.objectContaining({ name: "Fleet hub-1" }), expect.objectContaining({ name: "Fleet node-2" })]);
    expect(readFileSync(storeFile(home), "utf8")).toBe(issued);
    expect(JSON.parse(readFileSync(clientFile(home), "utf8"))).toEqual({ baseUrl: "http://127.0.0.1:3317/mcphub", token: issued });
    expect(statSync(clientFile(home)).mode & 0o777).toBe(0o600);
    expect((await fleet(["mcp-connect"], initialize)).code).toBe(0);
    expect(bridged.at(-1)).toBe(`POST Bearer ${issued}`);
  });

  test("without a key and with the hub down, apply names the failed pull and the client check", async () => {
    const { fleet } = machine(nodeMachine, {}, { "hub-1": "down" });
    gatewayServer();
    const applied = await fleet(["apply"]);
    expect(applied.output).toContain("Fix: Could not pull the credential of mcp-gateway/mcp-gateway from the hub hub-1 (ssh: connect to host hub-1 port 22: Connection refused). Fleet tries again at the next apply.");
    expect(applied.output).toContain("This machine cannot reach the MCP gateway.");
    expect(await fleet(["run", "mcp-gateway/mcp-gateway-client"])).toEqual({ code: 1, output: "This machine has no MCP gateway key. Run fleet apply on this machine to pull its key from the hub." });
  });

  test("fleet mcp-gateway typed on a devbox runs on the hub, with a server name that holds a space and shell characters", async () => {
    const tricky = "team docs; $(touch pwned) 'x'";
    const hub = machine(hubMachine);
    writeMcpHubSettings(hub.home, { mcpServers: { [tricky]: { oauth: { pendingAuthorization: { authorizationUrl: "https://auth.example.com/authorize?state=1" } } } } });
    const { state } = gatewayServer({ home: hub.home });
    const { fleet } = machine(nodeMachine, {}, { "hub-1": hub.host });
    expect(await fleet(["mcp-gateway", "reconnect", tricky])).toEqual({ code: 0, output: `MCPHub reconnected ${tricky}. If it needs a sign-in, run: fleet mcp-gateway sign-in` });
    expect(state.calls.map((call) => call.path)).toContain(`servers/${encodeURIComponent(tricky)}/reload`);
    expect(await fleet(["mcp-gateway", "sign-in"])).toEqual({ code: 0, output: `On your computer, keep this running while you sign in: coder port-forward hub-1 --tcp 3317\n${tricky}: https://auth.example.com/authorize?state=1` });
  });

  test("the hub's install check and the key issue stay off a devbox", async () => {
    const { home, fleet } = machine(nodeMachine);
    const { state } = gatewayServer();
    await fleet(["apply"]);
    expect(state.calls).toEqual([]);
    expect(existsSync(join(home, ".local/share/fleet-mcphub"))).toBe(false);
  });
});
