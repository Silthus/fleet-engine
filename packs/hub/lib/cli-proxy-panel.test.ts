import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { cliProxy, panelUrl, proxyUrl, type Panel, type ProxyMachine } from "./cli-proxy.ts";
import { fakeRun, modeOf, roleHome } from "./run-testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const clientKey = "c1".repeat(32);
const managementKey = "d2".repeat(32);
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const asset = (version: string, url: string, body: string) => ({ version, url, sha256: hash(body) });
const bodies: Record<string, string> = { "https://example.com/proxy.tar.gz": "proxy archive", "https://example.com/management.html": "<html>panel</html>", "https://example.com/quota-ledger.so": "ledger plugin" };
const release = asset("9.9.9", "https://example.com/proxy.tar.gz", "proxy archive");
const panel: Panel = { page: asset("1.2.3-fleet.1", "https://example.com/management.html", "<html>panel</html>"), plugin: asset("0.1.0", "https://example.com/quota-ledger.so", "ledger plugin"), historyDays: 35 };
const dataDir = (home: string) => join(home, ".local/share/fleet-cli-proxy");
const files = (home: string) => ({
  config: join(dataDir(home), "config.yaml"), unit: join(home, ".config/systemd/user/fleet-cli-proxy.service"), page: join(dataDir(home), "static/management.html"),
  plugin: join(dataDir(home), "plugins/quota-ledger.so"), ledger: join(dataDir(home), "quota-ledger/samples.jsonl"), management: join(dataDir(home), "management.env"),
});

type Proxy = { page?: number; ledger?: number };

function hub(fields: Partial<ProxyMachine> = {}, proxy: Proxy = {}, tampered?: string) {
  const home = fields.home ?? roleHome(temp.make("fleet-cli-proxy-panel-"), "hub");
  const fake = fakeRun((command) => {
    if (command[0] === "curl") writeFileSync(command[command.indexOf("-o") + 1]!, command[2] === tampered ? "tampered" : bodies[command[2]!]!);
    if (command[0] === "install") writeFileSync(command.at(-1)!, "binary");
    const installed = existsSync(join(dataDir(home), "cli-proxy-api"));
    if (command[0]!.endsWith("cli-proxy-api")) return { stdout: installed ? `CLIProxyAPI Version: ${release.version}\n` : "", code: installed ? 0 : 127 };
    if (command[0] === "ss") return { stdout: "LISTEN 0 4096 127.0.0.1:8317 0.0.0.0:*\n" };
    return undefined;
  });
  const requests: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    requests.push(`${url.pathname}${url.search}`);
    if (url.origin !== proxyUrl) throw new TypeError("connection refused");
    if (url.pathname === "/management.html") return new Response("<html>panel</html>", { status: proxy.page ?? 404 });
    if (url.pathname.startsWith("/v0/management/") && auth !== `Bearer ${managementKey}`) return new Response("no", { status: 401 });
    if (url.pathname === "/v0/management/quota-ledger/samples") return proxy.ledger === undefined || proxy.ledger === 200 ? Response.json({ samples: [] }) : new Response("missing", { status: proxy.ledger });
    if (url.pathname === "/v0/management/routing/strategy") return Response.json({ strategy: "fill-first" });
    if (url.pathname === "/v0/management/auth-files") return Response.json({ files: [{ provider: "claude" }, { provider: "claude" }] });
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "claude-sonnet-5-5" }] });
    return new Response("missing", { status: 404 });
  };
  const printed: string[] = [];
  const keys = [clientKey, managementKey];
  const machine: ProxyMachine = {
    home, uid: 1000, user: "me", accounts: 2, devboxes: [], release, run: fake.run, fetch, now: () => 1_800_000_000_000, sleep: async () => {},
    readStdin: async () => "", randomKey: () => keys.shift()!, print: (line) => printed.push(line), ...fields,
  };
  return { machine, home, calls: fake.calls, requests, printed };
}

const yaml = (home: string) => Bun.YAML.parse(readFileSync(files(home).config, "utf8")) as Record<string, unknown>;

test("by default the proxy keeps its management panel off: no page, no plugin, and a loopback config with the control panel disabled", async () => {
  const { machine, home, calls, printed } = hub();
  expect(await cliProxy("plan", machine)).toBe(0);
  expect(printed).toContain("  Keep the management panel off. Turn on the Proxy panel workflow to serve it.");
  expect(await cliProxy("install", machine)).toBe(0);
  const config = yaml(home);
  expect([config.host, config.port, config["remote-management"]]).toEqual(["127.0.0.1", 8317, { "allow-remote": false, "secret-key": "", "disable-control-panel": true }]);
  expect(config.plugins).toBeUndefined();
  expect(readFileSync(files(home).unit, "utf8")).not.toContain("MANAGEMENT_STATIC_PATH");
  expect(calls.filter((call) => call.startsWith("curl"))).toEqual([expect.stringContaining(release.url)]);
  expect([existsSync(files(home).page), existsSync(files(home).plugin)]).toEqual([false, false]);
});

test("the doctor fails a proxy that serves its panel while the Proxy panel workflow is off, and passes one that does not", async () => {
  const { machine, home } = hub();
  await cliProxy("install", machine);
  await expect(cliProxy("doctor", hub({ home }, { page: 200 }).machine)).rejects.toThrow(`The management panel answers at ${panelUrl}, but the Proxy panel workflow is off.`);
  const closed = hub({ home }, { page: 404 });
  expect(await cliProxy("doctor", closed.machine)).toBe(0);
  expect(closed.printed.join("\n")).not.toContain("management panel");
});

test("with the Proxy panel on, install fetches and checks the pinned page and plugin, and turns the panel on with quota history, still on loopback only", async () => {
  const { machine, home, calls, printed } = hub({ panel });
  expect(await cliProxy("plan", machine)).toBe(0);
  expect(printed).toContain(`  Serve the management panel 1.2.3-fleet.1 at ${panelUrl}, loopback only, with 35 days of quota history from the quota-ledger plugin 0.1.0.`);
  expect(await cliProxy("install", machine)).toBe(0);
  const config = yaml(home);
  expect([config.host, config.port, config["remote-management"]]).toEqual(["127.0.0.1", 8317, { "allow-remote": false, "secret-key": "", "disable-control-panel": false, "disable-auto-update-panel": true }]);
  expect(config.plugins).toEqual({ enabled: true, dir: join(dataDir(home), "plugins"), configs: { "quota-ledger": { enabled: true, path: files(home).ledger, "retention-days": 35 } } });
  expect(readFileSync(files(home).unit, "utf8")).toContain(`\nEnvironment=MANAGEMENT_STATIC_PATH=${files(home).page}\n`);
  expect([readFileSync(files(home).page, "utf8"), readFileSync(files(home).plugin, "utf8")]).toEqual(["<html>panel</html>", "ledger plugin"]);
  for (const path of [files(home).page, files(home).plugin]) expect([path, modeOf(statSync(path))]).toEqual([path, "600"]);
  for (const url of [panel.page.url, panel.plugin.url]) expect(calls.some((call) => call.startsWith(`curl -fsSL ${url} -o `))).toBe(true);
  expect(calls).toContain("systemctl --user restart fleet-cli-proxy.service");
  expect(calls.join("\n")).not.toContain(managementKey);

  const again = hub({ home, panel });
  expect(await cliProxy("install", again.machine)).toBe(0);
  expect(again.calls.some((call) => call.startsWith("curl") || call.includes("restart"))).toBe(false);
});

test("install stops at a panel page or plugin whose checksum differs, before it places it or turns the panel on", async () => {
  for (const url of [panel.page.url, panel.plugin.url]) {
    const { machine, home } = hub({ panel }, {}, url);
    await expect(cliProxy("install", machine)).rejects.toThrow(`Checksum mismatch for ${url}.`);
    expect([existsSync(files(home).config), existsSync(url === panel.page.url ? files(home).page : files(home).plugin)]).toEqual([false, false]);
  }
});

test("a new plugin restarts the proxy, which loads plugins only at start, and a new page does not", async () => {
  const { machine, home } = hub({ panel });
  await cliProxy("install", machine);
  writeFileSync(files(home).page, "old page");
  const page = hub({ home, panel });
  await cliProxy("install", page.machine);
  expect([readFileSync(files(home).page, "utf8"), page.calls.includes("systemctl --user restart fleet-cli-proxy.service")]).toEqual(["<html>panel</html>", false]);
  writeFileSync(files(home).plugin, "old plugin");
  const plugin = hub({ home, panel });
  await cliProxy("install", plugin.machine);
  expect([readFileSync(files(home).plugin, "utf8"), plugin.calls.includes("systemctl --user restart fleet-cli-proxy.service")]).toEqual(["ledger plugin", true]);
});

test("with the panel on, the doctor wants the pinned files, a page that loads and a ledger that answers, and names where to sign in without the key", async () => {
  const { machine, home } = hub({ panel });
  await cliProxy("install", machine);
  const healthy = hub({ home, panel }, { page: 200 });
  expect(await cliProxy("doctor", healthy.machine)).toBe(0);
  expect(healthy.requests).toContain("/v0/management/quota-ledger/samples?since=1800000000000");
  expect(healthy.printed).toContain(`Open the management panel at ${panelUrl} on the hub, or on a devbox through its tunnel, and sign in with the MANAGEMENT_PASSWORD in ${files(home).management}.`);
  expect(healthy.printed.join("\n")).not.toContain(managementKey);
  await expect(cliProxy("doctor", hub({ home, panel }, { page: 404 }).machine)).rejects.toThrow(`The management panel does not load at ${panelUrl}.`);
  await expect(cliProxy("doctor", hub({ home, panel }, { page: 200, ledger: 404 }).machine)).rejects.toThrow("The quota-ledger plugin does not answer");
  await expect(cliProxy("doctor", hub({ home }, { page: 200 }).machine)).rejects.toThrow("differ from what install writes now");
  writeFileSync(files(home).page, "changed");
  await expect(cliProxy("doctor", hub({ home, panel }, { page: 200 }).machine)).rejects.toThrow(`${files(home).page} is not version 1.2.3-fleet.1.`);
});

test("turning the panel off again removes its page and plugin, keeps the quota history, disables the control panel, and restarts the proxy", async () => {
  const { machine, home } = hub({ panel });
  await cliProxy("install", machine);
  mkdirSync(join(dataDir(home), "quota-ledger"), { recursive: true });
  writeFileSync(files(home).ledger, "{}\n");
  const off = hub({ home });
  expect(await cliProxy("install", off.machine)).toBe(0);
  expect([existsSync(files(home).page), existsSync(files(home).plugin), readFileSync(files(home).ledger, "utf8")]).toEqual([false, false, "{}\n"]);
  expect(yaml(home)["remote-management"]).toEqual(expect.objectContaining({ "disable-control-panel": true }));
  expect(yaml(home).plugins).toBeUndefined();
  expect(off.calls).toContain("systemctl --user restart fleet-cli-proxy.service");
});

test("a history length that is not a whole number of days stops install before it changes anything", async () => {
  for (const historyDays of [0, 1.5]) {
    const { machine, home } = hub({ panel: { ...panel, historyDays } });
    await expect(cliProxy("install", machine)).rejects.toThrow("hub.proxyHistoryDays must be a whole number of days, 1 or more");
    expect(existsSync(dataDir(home))).toBe(false);
  }
});
