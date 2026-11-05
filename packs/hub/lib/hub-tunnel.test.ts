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
  let state = loaded;
  const fake = fakeRun((command) => {
    if (command[1] === "print") return { code: state ? 0 : 113 };
    if (command[1] === "bootstrap") state = true;
    if (command[1] === "bootout") state = false;
    return undefined;
  });
  let asked = 0;
  const slept: number[] = [];
  const printed: string[] = [];
  const deps: MacTunnel = {
    home, platform: "darwin", uid: 501, alias: "my-hub", relayPort: 60002, gateway: { httpsHost: "hub.internal.example.com", relayPort: 60002 }, coder: "/opt/bin/coder",
    run: fake.run,
    fetch: async (url) => (asked++, new Response(null, { status: asked >= healthy && String(url) === "http://127.0.0.1:3317/health" ? 200 : 502 })),
    sleep: async (ms) => void slept.push(ms),
    print: (line) => printed.push(line),
    ...overrides,
  };
  return { deps, home, calls: fake.calls, slept, printed };
}

const agent = (home: string) => join(home, `Library/LaunchAgents/${tunnelLabel}.plist`);

test("the Mac's launch agent forwards only the MCP gateway port and the relay port from the hub, and never a proxy port", () => {
  const plist = agentPlist("/opt/bin/coder", "my-hub", 60002, "/Users/me/Library/Logs/fleet-hub-tunnel.log");
  const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  expect(args).toEqual([tunnelLabel, "/opt/bin/coder", "port-forward", "my-hub", "--tcp", "127.0.0.1:3317:3317", "--tcp", "127.0.0.1:60002:60002", "--disable-autostart", "/Users/me/Library/Logs/fleet-hub-tunnel.log", "/Users/me/Library/Logs/fleet-hub-tunnel.log"]);
  expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  expect(plist).not.toContain("8317");
  expect(agentPlist("/odd&<path>/coder", "my-hub", 60002, "/log")).toContain("<string>/odd&amp;&lt;path&gt;/coder</string>");
});

test("the agent's label is not one of the engine's job labels, so fleet apply never removes it as a stale job", () => {
  expect(tunnelLabel.startsWith("dev.fleet.")).toBe(false);
});

test("install writes the agent with mode 600, loads it, points the gateway key at the tunnel, and waits for the gateway on the injected clock", async () => {
  const { deps, home, calls, slept, printed } = mac({ healthy: 3 });
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/mcphub.client.json"), JSON.stringify({ baseUrl: "https://hub.internal.example.com:60002/mcphub", token: "secret_token" }));
  expect(await hubTunnel("install", deps)).toBe(0);
  expect(readFileSync(agent(home), "utf8")).toBe(agentPlist("/opt/bin/coder", "my-hub", 60002, join(home, "Library/Logs/fleet-hub-tunnel.log")));
  expect(modeOf(statSync(agent(home)))).toBe("600");
  expect(calls).toContain(`launchctl bootstrap gui/501 ${agent(home)}`);
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
  expect(again.calls.some((call) => /bootout|bootstrap/.test(call))).toBe(false);
  const moved = mac({ home, loaded: true, relayPort: 60003 });
  await hubTunnel("install", moved.deps);
  expect(moved.calls.filter((call) => /bootout|bootstrap/.test(call)).map((call) => call.split(" ")[1])).toEqual(["bootout", "bootstrap"]);
  expect(readFileSync(agent(home), "utf8")).toContain("127.0.0.1:60003:60003");
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
  expect(plan.calls).toEqual([]);
  expect(existsSync(join(plan.home, "Library"))).toBe(false);
  const removed = mac({ home, loaded: true });
  expect(await hubTunnel("remove", removed.deps)).toBe(0);
  expect(removed.calls).toContain(`launchctl bootout gui/501/${tunnelLabel}`);
  expect(existsSync(agent(home))).toBe(false);
});

test("remove keeps a linked LaunchAgents folder and an agent Fleet did not write, and unloads nothing", async () => {
  const home = temp.make("fleet-mac-");
  const elsewhere = temp.make("fleet-elsewhere-");
  writeFileSync(join(elsewhere, `${tunnelLabel}.plist`), agentPlist("/opt/bin/coder", "my-hub", 60002, "/log"));
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
  expect([...linked.calls, ...unmanaged.calls].some((call) => call.includes("bootout"))).toBe(false);
});

test("the agent carries its ownership mark as a comment right after the XML declaration, and a plist that only quotes the label elsewhere is not Fleet's", async () => {
  const plist = agentPlist("/opt/bin/coder", "my-hub", 60002, "/log");
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
