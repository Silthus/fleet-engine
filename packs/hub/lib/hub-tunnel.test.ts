import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { agentPlist, hubTunnel, tunnelLabel, type MacTunnel } from "./hub-tunnel.ts";
import { fakeRun, modeOf } from "./run-testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function mac(fields: Partial<MacTunnel> & { loaded?: boolean; healthy?: number } = {}) {
  const { loaded = false, healthy = 1, ...overrides } = fields;
  const home = fields.home ?? temp.make("fleet-mac-");
  const launchd = { running: loaded ? readIfThere(agent(home)) ?? "an agent loaded before" : undefined, starts: 0 };
  const target = `gui/501/${tunnelLabel}`;
  const fake = fakeRun((command) => {
    const [tool, verb, domain, path] = command;
    if (tool !== "launchctl") return { code: 127 };
    if (verb === "print") return { code: domain === target && launchd.running !== undefined ? 0 : 113 };
    if (verb === "bootout" && domain === target && launchd.running !== undefined) return (launchd.running = undefined), { code: 0 };
    if (verb === "bootstrap" && domain === "gui/501" && path && launchd.running === undefined) return (launchd.running = readFileSync(path, "utf8")), launchd.starts++, { code: 0 };
    return { code: 5 };
  });
  let asked = 0;
  const slept: number[] = [];
  const printed: string[] = [];
  const deps: MacTunnel = {
    home, platform: "darwin", uid: 501, alias: "my-hub", relayPort: 60002, gateway: true, httpsHost: "hub.internal.example.com", coder: "/opt/bin/coder",
    run: fake.run,
    fetch: async (url) => (asked++, new Response(null, { status: asked >= healthy && String(url) === "http://127.0.0.1:3317/health" ? 200 : 502 })),
    sleep: async (ms) => void slept.push(ms),
    print: (line) => printed.push(line),
    ...overrides,
  };
  return { deps, home, launchd, slept, printed };
}

function agent(home: string) {
  return join(home, `Library/LaunchAgents/${tunnelLabel}.plist`);
}

function readIfThere(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

const forwards = (plist: string | undefined) => [...(plist ?? "").matchAll(/<string>127\.0\.0\.1:(\d+):\d+<\/string>/g)].map((match) => Number(match[1]));

test("the Mac's launch agent forwards only the MCP gateway port and the relay port from the hub, and never a proxy port", () => {
  const plist = agentPlist("/opt/bin/coder", "my-hub", [3317, 60002], "/Users/me/Library/Logs/fleet-hub-tunnel.log");
  const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  expect(args).toEqual([tunnelLabel, "/opt/bin/coder", "port-forward", "my-hub", "--tcp", "127.0.0.1:3317:3317", "--tcp", "127.0.0.1:60002:60002", "--disable-autostart", "/Users/me/Library/Logs/fleet-hub-tunnel.log", "/Users/me/Library/Logs/fleet-hub-tunnel.log"]);
  expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  expect(plist).not.toContain("8317");
  expect(agentPlist("/odd&<path>/coder", "my-hub", [3317, 60002], "/log")).toContain("<string>/odd&amp;&lt;path&gt;/coder</string>");
});

test("the agent's label is not one of the engine's job labels, so fleet apply never removes it as a stale job", () => {
  expect(tunnelLabel.startsWith("dev.fleet.")).toBe(false);
});

test("install writes the agent with mode 600, loads it, points the gateway key at the tunnel, and waits for the gateway on the injected clock", async () => {
  const { deps, home, launchd, slept, printed } = mac({ healthy: 3 });
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/mcphub.client.json"), JSON.stringify({ baseUrl: "https://hub.internal.example.com:60002/mcphub", token: "secret_token" }));
  expect(await hubTunnel("install", deps)).toBe(0);
  expect(readFileSync(agent(home), "utf8")).toBe(agentPlist("/opt/bin/coder", "my-hub", [3317, 60002], join(home, "Library/Logs/fleet-hub-tunnel.log")));
  expect(modeOf(statSync(agent(home)))).toBe("600");
  expect(launchd.running).toBe(readFileSync(agent(home), "utf8"));
  expect(JSON.parse(readFileSync(join(home, ".config/fleet/mcphub.client.json"), "utf8"))).toEqual({ baseUrl: "http://127.0.0.1:3317/mcphub", token: "secret_token" });
  expect(modeOf(statSync(join(home, ".config/fleet/mcphub.client.json")))).toBe("600");
  expect(slept).toEqual([1000, 1000]);
  expect(printed.join("\n")).not.toContain("secret_token");
  expect(printed.at(-1)).toBe("Hub tunnel: forwards 127.0.0.1:3317 and 127.0.0.1:60002 to my-hub from login.");
});

test("a second install with nothing changed leaves the loaded agent alone, and a new relay port reloads it", async () => {
  const { deps, home } = mac();
  await hubTunnel("install", deps);
  const again = mac({ home, loaded: true });
  await hubTunnel("install", again.deps);
  expect(again.launchd.starts).toBe(0);
  const moved = mac({ home, loaded: true, relayPort: 60003 });
  await hubTunnel("install", moved.deps);
  expect(moved.launchd.starts).toBe(1);
  expect(forwards(moved.launchd.running)).toEqual([3317, 60003]);
});

test("the doctor fails with what to run when the gateway never answers through the tunnel", async () => {
  const { deps, home } = mac();
  await hubTunnel("install", deps);
  const down = mac({ home, loaded: true, healthy: 99 });
  await expect(hubTunnel("doctor", down.deps)).rejects.toThrow("127.0.0.1:3317 does not reach the MCP gateway on my-hub");
  expect(down.slept).toHaveLength(9);
  await expect(hubTunnel("doctor", mac().deps)).rejects.toThrow("Run fleet hub-tunnel install");
});

test("install refuses off a Mac, as root, without the Coder CLI, and with a bad hub name", async () => {
  await expect(hubTunnel("install", mac({ platform: "linux" }).deps)).rejects.toThrow("Only a Mac opens its own hub tunnel");
  await expect(hubTunnel("install", mac({ uid: 0 }).deps)).rejects.toThrow("not root");
  await expect(hubTunnel("install", mac({ coder: undefined }).deps)).rejects.toThrow("Install the Coder CLI");
  await expect(hubTunnel("install", mac({ alias: "-bad" }).deps)).rejects.toThrow("hub.alias");
});

test("install keeps a linked agent path and an agent Fleet did not write", async () => {
  const home = temp.make("fleet-mac-");
  const elsewhere = temp.make("fleet-elsewhere-");
  mkdirSync(join(home, "Library"), { recursive: true });
  symlinkSync(elsewhere, join(home, "Library/LaunchAgents"));
  await expect(hubTunnel("install", mac({ home }).deps)).rejects.toThrow("Keep linked hub tunnel path");
  expect(existsSync(join(elsewhere, `${tunnelLabel}.plist`))).toBe(false);
  const other = temp.make("fleet-mac-");
  mkdirSync(join(other, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(agent(other), "<plist>someone else's</plist>");
  await expect(hubTunnel("install", mac({ home: other }).deps)).rejects.toThrow("Keep unmanaged hub tunnel file");
});

test("remove unloads and deletes the agent, and plan changes nothing", async () => {
  const { deps, home } = mac();
  await hubTunnel("install", deps);
  const plan = mac({ home: temp.make("fleet-mac-") });
  expect(await hubTunnel("plan", plan.deps)).toBe(0);
  expect(plan.launchd.running).toBeUndefined();
  expect(existsSync(join(plan.home, "Library"))).toBe(false);
  const removed = mac({ home, loaded: true });
  expect(await hubTunnel("remove", removed.deps)).toBe(0);
  expect(removed.launchd.running).toBeUndefined();
  expect(existsSync(agent(home))).toBe(false);
});

test("remove keeps a linked LaunchAgents folder and an agent Fleet did not write, and unloads nothing", async () => {
  const home = temp.make("fleet-mac-");
  const elsewhere = temp.make("fleet-elsewhere-");
  writeFileSync(join(elsewhere, `${tunnelLabel}.plist`), agentPlist("/opt/bin/coder", "my-hub", [3317, 60002], "/log"));
  mkdirSync(join(home, "Library"), { recursive: true });
  symlinkSync(elsewhere, join(home, "Library/LaunchAgents"));
  const linked = mac({ home, loaded: true });
  await expect(hubTunnel("remove", linked.deps)).rejects.toThrow("Keep linked hub tunnel path");
  expect(existsSync(join(elsewhere, `${tunnelLabel}.plist`))).toBe(true);
  const other = temp.make("fleet-mac-");
  mkdirSync(join(other, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(agent(other), `<plist><string>${tunnelLabel}</string></plist>`);
  const unmanaged = mac({ home: other, loaded: true });
  await expect(hubTunnel("remove", unmanaged.deps)).rejects.toThrow("Keep unmanaged hub tunnel file");
  expect(existsSync(agent(other))).toBe(true);
  expect([linked.launchd.running, unmanaged.launchd.running]).toEqual([readFileSync(join(elsewhere, `${tunnelLabel}.plist`), "utf8"), readFileSync(agent(other), "utf8")]);
});

test("the agent carries its ownership mark as a comment right after the XML declaration, and a plist that only quotes the label elsewhere is not Fleet's", async () => {
  const plist = agentPlist("/opt/bin/coder", "my-hub", [3317, 60002], "/log");
  expect(plist.split("\n").slice(0, 2)).toEqual([`<?xml version="1.0" encoding="UTF-8"?>`, "<!-- Managed by Fleet hub tunnel. -->"]);
  const home = temp.make("fleet-mac-");
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  const quoting = plist.replace("<!-- Managed by Fleet hub tunnel. -->\n", "").replace("</dict>", "  <key>Comment</key>\n  <string><!-- Managed by Fleet hub tunnel. --></string>\n</dict>");
  writeFileSync(agent(home), quoting);
  await expect(hubTunnel("install", mac({ home }).deps)).rejects.toThrow("Keep unmanaged hub tunnel file");
});

test("the doctor fails when the owned agent differs from what install writes now, such as an old hub name or relay port", async () => {
  const { deps, home } = mac();
  await hubTunnel("install", deps);
  expect(await hubTunnel("doctor", mac({ home, loaded: true }).deps)).toBe(0);
  await expect(hubTunnel("doctor", mac({ home, loaded: true, relayPort: 60003 }).deps)).rejects.toThrow(agent(home));
  await expect(hubTunnel("doctor", mac({ home, loaded: true, alias: "new-hub" }).deps)).rejects.toThrow("Run fleet hub-tunnel install");
  await expect(hubTunnel("doctor", mac({ home, loaded: true, coder: "/usr/local/bin/coder" }).deps)).rejects.toThrow(agent(home));
});

test("a hub named by its Coder SSH name, as coder config-ssh writes it, forwards from its workspace", async () => {
  const { deps, home, printed } = mac({ alias: "coder.my-hub" });
  expect(await hubTunnel("install", deps)).toBe(0);
  const args = [...readFileSync(agent(home), "utf8").matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  expect(args.slice(1, 4)).toEqual(["/opt/bin/coder", "port-forward", "my-hub"]);
  expect(printed.at(-1)).toBe("Hub tunnel: forwards 127.0.0.1:3317 and 127.0.0.1:60002 to coder.my-hub from login.");
  await expect(hubTunnel("install", mac({ alias: "other.my-hub" }).deps)).rejects.toThrow("hub.alias");
});

test("with hub HTTPS and without the MCP gateway the agent forwards only the relay port, and asks the gateway nothing", async () => {
  const { deps, home, launchd, printed } = mac({ gateway: false, healthy: 99 });
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  const client = JSON.stringify({ baseUrl: "https://hub.internal.example.com:60002/mcphub", token: "secret_token" });
  writeFileSync(join(home, ".config/fleet/mcphub.client.json"), client);
  expect(await hubTunnel("install", deps)).toBe(0);
  expect(forwards(launchd.running)).toEqual([60002]);
  expect(readFileSync(join(home, ".config/fleet/mcphub.client.json"), "utf8")).toBe(client);
  expect(printed.at(-1)).toBe("Hub tunnel: forwards 127.0.0.1:60002 to my-hub from login.");
  expect(await hubTunnel("doctor", mac({ home, loaded: true, gateway: false, healthy: 99 }).deps)).toBe(0);
});

test("with the MCP gateway and without hub HTTPS the agent forwards only the gateway port", async () => {
  const { deps, launchd, printed } = mac({ httpsHost: undefined });
  expect(await hubTunnel("install", deps)).toBe(0);
  expect(forwards(launchd.running)).toEqual([3317]);
  expect(printed.at(-1)).toBe("Hub tunnel: forwards 127.0.0.1:3317 to my-hub from login.");
});

const notNeeded = "Hub tunnel: not needed. The MCP gateway is off and hub.httpsHost is empty, so this Mac forwards nothing to the hub.";

test("without the MCP gateway or hub HTTPS the doctor fails while Fleet's agent is still there, and install takes it away", async () => {
  const { deps, home } = mac();
  await hubTunnel("install", deps);
  const off = { gateway: false, httpsHost: undefined };
  await expect(hubTunnel("doctor", mac({ home, loaded: true, ...off }).deps)).rejects.toThrow("The hub tunnel should go. The MCP gateway is off and hub.httpsHost is empty, so this Mac forwards nothing to the hub. Run fleet hub-tunnel install to remove it.");
  const removing = mac({ home, loaded: true, ...off });
  expect(await hubTunnel("install", removing.deps)).toBe(0);
  expect(existsSync(agent(home))).toBe(false);
  expect(removing.launchd.running).toBeUndefined();
  expect(removing.printed.at(-1)).toBe(notNeeded);
  expect(await hubTunnel("doctor", mac({ home, ...off }).deps)).toBe(0);
});

test("without the MCP gateway or hub HTTPS a loaded agent whose file is gone fails the doctor until install unloads it", async () => {
  const off = { gateway: false, httpsHost: undefined };
  const stray = mac({ loaded: true, ...off });
  await expect(hubTunnel("doctor", stray.deps)).rejects.toThrow("The hub tunnel should go");
  expect(await hubTunnel("install", stray.deps)).toBe(0);
  expect(stray.launchd.running).toBeUndefined();
  expect(await hubTunnel("doctor", stray.deps)).toBe(0);
});

test("without the MCP gateway or hub HTTPS a Mac that never had the agent passes the doctor, and install writes nothing", async () => {
  const fresh = mac({ gateway: false, httpsHost: undefined, coder: undefined });
  expect(await hubTunnel("doctor", fresh.deps)).toBe(0);
  expect(await hubTunnel("install", fresh.deps)).toBe(0);
  expect(fresh.printed).toEqual([notNeeded, notNeeded]);
  expect(fresh.launchd.starts).toBe(0);
  expect(existsSync(join(fresh.home, "Library"))).toBe(false);
});

async function hubTunnelCommand(profile: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  const dir = temp.make("fleet-profile-");
  writeFileSync(join(dir, "fleet.json"), JSON.stringify({ schema: 1, packs: ["hub"], workflows: {}, ...profile }));
  const child = Bun.spawn(["bun", join(import.meta.dir, "../commands/hub-tunnel.ts"), "doctor"], {
    env: { ...Bun.env, HOME: temp.make("fleet-mac-"), FLEET_PROFILE_DIR: dir, FLEET_SETTINGS: JSON.stringify({ "hub.alias": "coder.my-hub", "hub.relayPort": 60002, ...settings }) },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: `${stdout}${stderr}` };
}

test("fleet hub-tunnel reads from the profile whether the MCP gateway is on, which a profile with the Hub pack carries until its workflow is off, and from hub.httpsHost whether the relay is needed", async () => {
  const nothing = { code: 0, output: `${notNeeded}\n` };
  const tunnel = process.platform === "darwin" ? "hub tunnel" : "Only a Mac opens its own hub tunnel";
  expect(await hubTunnelCommand({ workflows: { "mcp-gateway": false } })).toEqual(nothing);
  expect(await hubTunnelCommand({ packs: ["hub", "mcp-gateway"], workflows: { "mcp-gateway": false } })).toEqual(nothing);
  for (const packs of [["hub"], ["hub", "mcp-gateway"]]) {
    const on = await hubTunnelCommand({ packs });
    expect(on.code).not.toBe(0);
    expect(on.output).toContain(tunnel);
  }
  const relay = await hubTunnelCommand({ workflows: { "mcp-gateway": false } }, { "hub.httpsHost": "hub.internal.example.com" });
  expect(relay.code).not.toBe(0);
  expect(relay.output).toContain(tunnel);
});

test("left reports a launch agent Fleet wrote or one that is loaded, and nothing once remove took it away", async () => {
  const { deps, home } = mac();
  await hubTunnel("install", deps);
  expect(await hubTunnel("left", deps)).toBe(0);
  expect(await hubTunnel("remove", deps)).toBe(0);
  expect(existsSync(agent(home))).toBe(false);
  expect(await hubTunnel("left", deps)).toBe(1);
  expect(await hubTunnel("left", mac({ loaded: true }).deps)).toBe(0);
});
