import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { tempDirs } from "../../../src/testing/git.ts";
import { cliProxy, type ProxyMachine } from "./cli-proxy.ts";
import { handOver, hubForward } from "./links.ts";
import { roleHome } from "./run-testing.ts";
import { proxyOn, readBoxSettings } from "./machine.ts";
import { boxSettings, fakeCoder, fakeMachine, ok, writeHome } from "./testing.ts";
import { tunnelUnit } from "./tunnels.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const clientKey = "c1".repeat(32);
const balancing = readBoxSettings({ FLEET_SETTINGS: JSON.stringify({ ...boxSettings, "hub.proxyAccounts": 2 }) });
const proxyRoute = "'-R' '8317:127.0.0.1:8317'";

test("the proxy is on for fleet commands only while Own-account balancing is on, which hands them hub.proxyAccounts", () => {
  expect(proxyOn({ FLEET_SETTINGS: JSON.stringify(boxSettings) })).toBe(false);
  expect(proxyOn({ FLEET_SETTINGS: JSON.stringify({ ...boxSettings, "hub.proxyAccounts": 2 }) })).toBe(true);
  expect(balancing.proxy).toBe(true);
  expect(readBoxSettings({ FLEET_SETTINGS: JSON.stringify(boxSettings) }).proxy).toBeUndefined();
});

test("a devbox tunnel carries the proxy port only while the workflow is on", () => {
  expect(tunnelUnit("devbox-1", 60002)).not.toContain("8317");
  const unit = tunnelUnit("devbox-1", 60002, true);
  expect(unit).toContain("-R 127.0.0.1:8317:127.0.0.1:8317");
  expect([...unit.matchAll(/ -R /g)]).toHaveLength(3);
});

test("a box's hub forward carries the proxy port only while the workflow is on", () => {
  const off = fakeMachine(temp.make("fleet-box-")).machine;
  expect(hubForward(off, "box-lane").map((arg) => `'${arg}'`).join(" ")).not.toContain("8317");
  const on = fakeMachine(temp.make("fleet-box-"), { settings: balancing }).machine;
  expect(hubForward(on, "box-lane").map((arg) => `'${arg}'`).join(" ")).toContain(proxyRoute);
});

test("handing over connects a box to the proxy with the key on stdin only, under umask 077, and skips it while the workflow is off", async () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/cli-proxy.key": `${clientKey}\n` });
  const on = fakeMachine(home, { settings: balancing, run: async () => ({ ...ok, code: 1 }) });
  const sent = fakeCoder();
  await handOver(sent.coder, on.machine, "box-lane");
  const connect = sent.calls.find((call) => call.command.includes("cli-proxy connect"));
  expect(connect?.stdin).toBe(`${clientKey}\n`);
  expect(connect?.command).toContain("umask 077");
  expect(sent.calls.map((call) => call.command).join("\n")).not.toContain(clientKey);

  const off = fakeMachine(home, { run: async () => ({ ...ok, code: 1 }) });
  const skipped = fakeCoder();
  await handOver(skipped.coder, off.machine, "box-lane");
  expect(skipped.calls.some((call) => call.command.includes("cli-proxy"))).toBe(false);
});

test("a box that cannot reach the proxy yet keeps its own sign-in, and the handover goes on", async () => {
  const on = fakeMachine(temp.make("fleet-box-"), { settings: balancing, run: async () => ({ ...ok, code: 1 }) });
  writeHome(on.machine.home, { ".config/fleet/cli-proxy.key": `${clientKey}\n` });
  const { coder } = fakeCoder({ ssh: async (_box, command) => ({ ...ok, code: command.includes("cli-proxy connect") ? 1 : 0, stderr: "The proxy does not answer." }) });
  await handOver(coder, on.machine, "box-lane");
  expect(on.lines).toContain("box-lane keeps its own sign-in: The proxy does not answer.");

  const none = fakeMachine(temp.make("fleet-box-"), { settings: balancing, run: async () => ({ ...ok, code: 1 }) });
  await handOver(fakeCoder().coder, none.machine, "box-lane");
  expect(none.lines).toContain("skip ~/.config/fleet/cli-proxy.key: this machine has none");
});

test("a relay port on the proxy port is refused only while the workflow is on, before any tunnel or box forward is built", () => {
  expect(() => tunnelUnit("devbox-1", 8317, true)).toThrow("while Own-account balancing is on, hub.relayPort cannot be 8317");
  const clash = fakeMachine(temp.make("fleet-box-"), { settings: { ...balancing, relayPort: 8317 } }).machine;
  expect(() => hubForward(clash, "box-lane")).toThrow("while Own-account balancing is on, hub.relayPort cannot be 8317");
  expect(tunnelUnit("devbox-1", 8317)).toContain("-R 127.0.0.1:8317:127.0.0.1:8317");
  const off = fakeMachine(temp.make("fleet-box-"), { settings: { ...readBoxSettings({ FLEET_SETTINGS: JSON.stringify(boxSettings) }), relayPort: 8317 } }).machine;
  expect(hubForward(off, "box-lane")).toContain("8317:127.0.0.1:8317");
});

test("a box handed over on the Codex plan sends Codex through the proxy without another apply", async () => {
  const hub = fakeMachine(temp.make("fleet-hub-"), { settings: balancing, run: async () => ({ ...ok, code: 1 }) });
  writeHome(hub.machine.home, { ".config/fleet/cli-proxy.key": `${clientKey}\n` });
  const boxHome = roleHome(temp.make("fleet-box-"), "devbox");
  const fetch = async () => Response.json({ data: [{ id: "gpt-6.1-sol" }] });
  const box = (stdin: string): ProxyMachine => ({ home: boxHome, uid: 1000, user: "me", plan: "codex", devboxes: [], release: { version: "", url: "", sha256: "" }, run: async () => ok, fetch, sleep: async () => {}, readStdin: async () => stdin, randomKey: () => clientKey, print: () => {} });
  const { coder } = fakeCoder({ ssh: async (_name, command, stdin) => (command.includes("cli-proxy connect") ? { ...ok, code: await cliProxy("connect", box(stdin ?? "")) } : ok) });
  await handOver(coder, hub.machine, "box-lane");
  expect(parse(readFileSync(join(boxHome, ".codex/config.toml"), "utf8")).model_provider).toBe("fleet-proxy");
  expect(existsSync(join(boxHome, ".claude/settings.json"))).toBe(false);
  expect(await cliProxy("check", box(""), "codex")).toBe(0);
});
