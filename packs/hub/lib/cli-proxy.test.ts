import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { claudeRoute, cliProxy, keyHelper, proxyUrl, type ProxyMachine } from "./cli-proxy.ts";
import { fakeRun, modeOf, roleHome } from "./run-testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const clientKey = "c1".repeat(32);
const otherKey = "d2".repeat(32);
const archive = "fake release archive";
const release = { version: "9.9.9", url: "https://example.com/proxy.tar.gz", sha256: new Bun.CryptoHasher("sha256").update(archive).digest("hex") };
const dataDir = (home: string) => join(home, ".local/share/fleet-cli-proxy");
const keyFile = (home: string) => join(home, ".config/fleet/cli-proxy.key");
const settingsFile = (home: string) => join(home, ".claude/settings.json");
const unitFile = (home: string) => join(home, ".config/systemd/user/fleet-cli-proxy.service");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

type Proxy = { strategy?: string; credentials?: Array<{ provider: string; disabled?: boolean }>; models?: string[]; down?: boolean };

function fakeProxy(proxy: Proxy = {}) {
  const requests: Array<{ path: string; method: string; auth: string }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    requests.push({ path: url.pathname, method: init?.method ?? "GET", auth });
    if (proxy.down || url.origin !== proxyUrl) throw new TypeError("connection refused");
    if (url.pathname === "/v1/models") return auth === `Bearer ${clientKey}` ? Response.json({ data: (proxy.models ?? ["claude-sonnet-5-5"]).map((id) => ({ id })) }) : new Response("no", { status: 401 });
    if (url.pathname === "/v0/management/routing/strategy") return Response.json({ strategy: proxy.strategy ?? "fill-first" });
    if (url.pathname === "/v0/management/auth-files") return Response.json({ files: proxy.credentials ?? [{ provider: "claude" }, { provider: "claude" }] });
    return new Response("missing", { status: 404 });
  };
  return { fetch, requests };
}

function hubMachine(fields: Partial<ProxyMachine> = {}, proxy: Proxy = {}, options: { role?: string; checksum?: string } = {}) {
  const home = fields.home ?? roleHome(temp.make("fleet-cli-proxy-"), options.role ?? "hub");
  const fake = fakeRun((command) => {
    if (command[0] === "curl") writeFileSync(command[command.indexOf("-o") + 1]!, options.checksum ?? archive);
    if (command[0] === "install") writeFileSync(command.at(-1)!, "binary");
    const installed = existsSync(join(dataDir(home), "cli-proxy-api"));
    if (command[0]!.endsWith("cli-proxy-api")) return { stdout: installed ? `CLIProxyAPI Version: ${release.version}, Commit: x\n` : "", code: installed ? 0 : 127 };
    if (command[0] === "ss") return { stdout: "LISTEN 0 4096 127.0.0.1:8317 0.0.0.0:*\n" };
    return undefined;
  });
  const { fetch, requests } = fakeProxy(proxy);
  const printed: string[] = [];
  const keys = [clientKey, otherKey];
  const machine: ProxyMachine = {
    home, uid: 1000, user: "me", accounts: 2, devboxes: ["devbox-1", "box-lane"], release, run: fake.run, fetch, sleep: async () => {},
    readStdin: async () => `${clientKey}\n`, randomKey: () => keys.shift()!, print: (line) => printed.push(line), ...fields,
  };
  return { machine, home, calls: fake.calls, inputs: fake.inputs, requests, printed };
}

const client = (fields: Partial<ProxyMachine> = {}, proxy: Proxy = {}) => hubMachine(fields, proxy, { role: "devbox" });

function connected(home: string, settings: Record<string, unknown> = {}) {
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(keyFile(home), `${clientKey}\n`, { mode: 0o600 });
  writeFileSync(settingsFile(home), JSON.stringify({ model: "opus", ...settings, env: { MY_FLAG: "1", ANTHROPIC_BASE_URL: proxyUrl, ...(settings.env as object) }, apiKeyHelper: keyHelper }));
}

test("plan on the hub names what install would do, and changes nothing", async () => {
  const { machine, home, calls, printed } = hubMachine();
  expect(await cliProxy("plan", machine)).toBe(0);
  expect(printed[0]).toBe("CLI proxy plan (no changes):");
  expect(printed.join("\n")).toContain("CLIProxyAPI 9.9.9");
  expect(calls.filter((call) => !call.endsWith("--help"))).toEqual([]);
  expect(existsSync(dataDir(home))).toBe(false);
});

test("install on the hub downloads the pinned release, checks it, and writes a loopback, fill-first config, a user unit, and private keys", async () => {
  const { machine, home, calls } = hubMachine();
  expect(await cliProxy("install", machine)).toBe(0);
  expect(calls).toContain(`curl -fsSL ${release.url} -o ${calls.find((call) => call.startsWith("curl"))!.split(" -o ")[1]}`);
  expect(calls.some((call) => call.startsWith("install -m 0755 ") && call.endsWith(join(dataDir(home), "cli-proxy-api")))).toBe(true);
  const config = readFileSync(join(dataDir(home), "config.yaml"), "utf8");
  expect(config.split("\n")[0]).toBe("# Managed by Fleet CLI proxy.");
  for (const line of ['host: "127.0.0.1"', "port: 8317", "  allow-remote: false", "  disable-control-panel: true", `  - "${clientKey}"`, '  strategy: "fill-first"', "  session-affinity: true", `auth-dir: "${join(dataDir(home), "auth")}"`]) expect(config).toContain(`${line}\n`);
  const unit = readFileSync(unitFile(home), "utf8");
  expect(unit).toContain(`ExecStart=${join(dataDir(home), "cli-proxy-api")} -config ${join(dataDir(home), "config.yaml")}`);
  expect(unit).toContain(`EnvironmentFile=${join(dataDir(home), "management.env")}`);
  expect(readFileSync(keyFile(home), "utf8")).toBe(`${clientKey}\n`);
  expect(readFileSync(join(dataDir(home), "management.env"), "utf8")).toBe(`MANAGEMENT_PASSWORD=${otherKey}\n`);
  for (const path of [keyFile(home), join(dataDir(home), "management.env"), join(dataDir(home), "config.yaml"), unitFile(home)]) expect([path, modeOf(statSync(path))]).toEqual([path, "600"]);
  for (const path of [dataDir(home), join(dataDir(home), "auth")]) expect(modeOf(statSync(path))).toBe("700");
  expect(calls).toContain("sudo -n loginctl enable-linger me");
  expect(calls).toContain("systemctl --user restart fleet-cli-proxy.service");
  expect(calls).toContain("systemctl --user enable --now fleet-cli-proxy.service");
  expect(calls.join("\n")).not.toContain(clientKey);
  expect(calls.join("\n")).not.toContain(otherKey);

  const again = hubMachine({ home, randomKey: () => { throw new Error("no new key"); } });
  expect(await cliProxy("install", again.machine)).toBe(0);
  expect(again.calls.some((call) => call.startsWith("curl") || call.includes("restart"))).toBe(false);
});

test("install stops at a release whose checksum differs, before it writes a unit", async () => {
  const { machine, home } = hubMachine({}, {}, { checksum: "tampered" });
  await expect(cliProxy("install", machine)).rejects.toThrow("Checksum mismatch");
  expect(existsSync(unitFile(home))).toBe(false);
});

test("install keeps files Fleet did not write, and refuses linked paths", async () => {
  const unmanaged = hubMachine();
  mkdirSync(dataDir(unmanaged.home), { recursive: true });
  writeFileSync(join(dataDir(unmanaged.home), "config.yaml"), "port: 9999\n");
  await expect(cliProxy("install", unmanaged.machine)).rejects.toThrow("Keep unmanaged CLI proxy file");
  expect(readFileSync(join(dataDir(unmanaged.home), "config.yaml"), "utf8")).toBe("port: 9999\n");

  const foreignKey = hubMachine();
  mkdirSync(join(foreignKey.home, ".config/fleet"), { recursive: true });
  writeFileSync(keyFile(foreignKey.home), "not a key\n");
  await expect(cliProxy("install", foreignKey.machine)).rejects.toThrow("Keep unmanaged CLI proxy file");

  const linked = hubMachine();
  mkdirSync(join(linked.home, ".local/share"), { recursive: true });
  symlinkSync(temp.make("elsewhere-"), dataDir(linked.home));
  await expect(cliProxy("install", linked.machine)).rejects.toThrow("Keep linked CLI proxy path");
});

test("install and doctor run only on the hub and never as root", async () => {
  await expect(cliProxy("install", client().machine)).rejects.toThrow("fleet cli-proxy install runs only on the hub");
  await expect(cliProxy("install", hubMachine({ uid: 0 }).machine)).rejects.toThrow("not root");
});

test("the doctor passes with enough of your own subscriptions, and prints how to connect each devbox without the key", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const doctor = hubMachine({ home });
  expect(await cliProxy("doctor", doctor.machine)).toBe(0);
  expect(doctor.calls).toContain("systemctl --user is-active --quiet fleet-cli-proxy.service");
  expect(doctor.requests.filter((request) => request.path.startsWith("/v0/management")).every((request) => request.auth === `Bearer ${otherKey}`)).toBe(true);
  expect(doctor.printed.join("\n")).toContain(`ssh devbox-1 'sh "$HOME/.local/share/fleet/engine/fleet" cli-proxy connect' < ~/.config/fleet/cli-proxy.key`);
  expect(doctor.printed.join("\n")).not.toContain("box-lane");
  expect(doctor.printed.join("\n")).not.toContain(clientKey);
});

test("the doctor names the login command while the proxy holds too few subscriptions, and asks for the balancer when routing is not fill-first", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const few = hubMachine({ home }, { credentials: [{ provider: "claude" }, { provider: "claude", disabled: true }, { provider: "codex" }] });
  await expect(cliProxy("doctor", few.machine)).rejects.toThrow(`Add at least 2 of your own Claude subscriptions; found 1. Run: ${join(dataDir(home), "cli-proxy-api")} -config ${join(dataDir(home), "config.yaml")} -claude-login -no-browser`);
  const spread = hubMachine({ home }, { strategy: "round-robin" });
  await expect(cliProxy("doctor", spread.machine)).rejects.toThrow("fleet cli-proxy-balance");
});

test("the doctor finds a changed unit and a proxy that listens beyond loopback", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  writeFileSync(unitFile(home), `${readFileSync(unitFile(home), "utf8")}# edited\n`);
  await expect(cliProxy("doctor", hubMachine({ home }).machine)).rejects.toThrow("fleet cli-proxy install");
  await cliProxy("install", hubMachine({ home }).machine);
  const open = hubMachine({ home, run: fakeRun((command) => (command[0] === "ss" ? { stdout: "LISTEN 0 4096 0.0.0.0:8317 0.0.0.0:*\n" } : command[0]!.endsWith("cli-proxy-api") ? { stdout: `CLIProxyAPI Version: ${release.version}\n` } : undefined)).run });
  await expect(cliProxy("doctor", open.machine)).rejects.toThrow("loopback only");
});

test("connect on a devbox checks the key against the proxy first, then saves it privately and sends Claude Code to the proxy", async () => {
  const { machine, home, requests, printed } = client();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(home), JSON.stringify({ model: "opus", env: { MY_FLAG: "1" } }));
  expect(await cliProxy("connect", machine)).toBe(0);
  expect(requests[0]).toEqual({ path: "/v1/models", method: "GET", auth: `Bearer ${clientKey}` });
  expect(readFileSync(keyFile(home), "utf8")).toBe(`${clientKey}\n`);
  expect(modeOf(statSync(keyFile(home)))).toBe("600");
  expect(readJson(settingsFile(home))).toEqual({ model: "opus", env: { MY_FLAG: "1", ANTHROPIC_BASE_URL: proxyUrl }, apiKeyHelper: keyHelper });
  expect(modeOf(statSync(settingsFile(home)))).toBe("600");
  expect(readFileSync(settingsFile(home), "utf8")).not.toContain(clientKey);
  expect(printed.join("\n")).toContain("Restart");
});

test("connect changes nothing for a key that is not hexadecimal, a proxy that does not answer, or Claude settings that point elsewhere", async () => {
  const bad = client({ readStdin: async () => "sk-not-a-key\n" });
  await expect(cliProxy("connect", bad.machine)).rejects.toThrow("hexadecimal");
  const down = client({}, { down: true });
  await expect(cliProxy("connect", down.machine)).rejects.toThrow("Nothing changed");
  expect(existsSync(keyFile(down.home))).toBe(false);
  expect(existsSync(settingsFile(down.home))).toBe(false);
  const elsewhere = client();
  mkdirSync(join(elsewhere.home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(elsewhere.home), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } }));
  await expect(cliProxy("connect", elsewhere.machine)).rejects.toThrow("Keep your Claude setting env.ANTHROPIC_BASE_URL");
  expect(existsSync(keyFile(elsewhere.home))).toBe(false);
  await expect(cliProxy("connect", hubMachine().machine)).rejects.toThrow("The hub has its own key");
});

test("the check passes while the proxy answers the saved key, and keeps Claude Code on the proxy", async () => {
  const { machine, home, printed } = client();
  connected(home);
  expect(await cliProxy("check", machine)).toBe(0);
  expect(readJson(settingsFile(home)).env.ANTHROPIC_BASE_URL).toBe(proxyUrl);
  expect(printed).toEqual([`Claude Code reaches your own-account proxy at ${proxyUrl}.`]);
});

test("the check reports an unreachable proxy and switches Claude Code back to its own sign-in, keeping your other settings", async () => {
  const { machine, home, printed } = client({}, { down: true });
  connected(home);
  expect(await cliProxy("check", machine)).toBe(1);
  expect(readJson(settingsFile(home))).toEqual({ model: "opus", env: { MY_FLAG: "1" } });
  expect(printed.join("\n")).toContain(`The proxy at ${proxyUrl} does not answer.`);
  expect(printed.join("\n")).toContain("Claude Code uses its own sign-in now.");
  expect(existsSync(keyFile(home))).toBe(true);
});

test("the check switches to direct sign-in without a saved key or when the proxy refuses it, and route does the same but never fails apply", async () => {
  const missing = client();
  connected(missing.home);
  writeFileSync(keyFile(missing.home), "");
  expect(await cliProxy("check", missing.machine)).toBe(1);
  expect(readJson(settingsFile(missing.home)).apiKeyHelper).toBeUndefined();
  expect(missing.printed.join("\n")).toContain("no proxy key");

  const refused = client({}, { models: ["gpt-6.1-sol"] });
  connected(refused.home);
  expect(await cliProxy("route", refused.machine)).toBe(0);
  expect(readJson(settingsFile(refused.home)).env).toEqual({ MY_FLAG: "1" });

  const fresh = client();
  expect(await cliProxy("route", fresh.machine)).toBe(0);
  expect(existsSync(settingsFile(fresh.home))).toBe(false);
});

test("the switch removes only Fleet's own values: a base URL or key helper you set stays", async () => {
  const { machine, home } = client({}, { down: true });
  connected(home);
  writeFileSync(settingsFile(home), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" }, apiKeyHelper: "my-helper" }));
  expect(await cliProxy("check", machine)).toBe(1);
  expect(readJson(settingsFile(home))).toEqual({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" }, apiKeyHelper: "my-helper" });
});

test("disconnect removes Fleet's Claude settings and the key, and says how to sign in again; the hub keeps its key", async () => {
  const { machine, home, printed } = client();
  connected(home);
  expect(await cliProxy("disconnect", machine)).toBe(0);
  expect(readJson(settingsFile(home))).toEqual({ model: "opus", env: { MY_FLAG: "1" } });
  expect(existsSync(keyFile(home))).toBe(false);
  expect(printed.join("\n")).toContain("run claude and enter /login");
  await expect(cliProxy("disconnect", hubMachine().machine)).rejects.toThrow("own-account-balancing=off");
});

test("a linked Claude settings file stops connect and the switch", async () => {
  const { machine, home } = client({}, { down: true });
  connected(home);
  const real = join(temp.make("real-"), "settings.json");
  writeFileSync(real, readFileSync(settingsFile(home)));
  rmSync(settingsFile(home));
  symlinkSync(real, settingsFile(home));
  await expect(cliProxy("check", machine)).rejects.toThrow("Keep linked Claude settings path");
});

test("install refuses a linked auth folder or binary before it changes modes or runs anything", async () => {
  const auth = hubMachine();
  const outside = temp.make("elsewhere-");
  chmodSync(outside, 0o755);
  mkdirSync(dataDir(auth.home), { recursive: true });
  symlinkSync(outside, join(dataDir(auth.home), "auth"));
  await expect(cliProxy("install", auth.machine)).rejects.toThrow("Keep linked CLI proxy path");
  expect(modeOf(statSync(outside))).toBe("755");
  expect(auth.calls).toEqual([]);

  const binary = hubMachine();
  mkdirSync(dataDir(binary.home), { recursive: true });
  symlinkSync(join(outside, "tool"), join(dataDir(binary.home), "cli-proxy-api"));
  await expect(cliProxy("install", binary.machine)).rejects.toThrow("Keep linked CLI proxy path");
  expect(binary.calls).toEqual([]);
});

test("install that fails after it writes a new management key restarts the proxy on the next run", async () => {
  let linger = 1;
  const { machine, home, calls } = hubMachine();
  const run = machine.run;
  machine.run = async (command, options) => (command[0] === "sudo" && linger-- > 0 ? { code: 1, stdout: "", stderr: "no sudo" } : run(command, options));
  await expect(cliProxy("install", machine)).rejects.toThrow();
  expect(existsSync(join(dataDir(home), "management.env"))).toBe(true);
  calls.length = 0;
  expect(await cliProxy("install", machine)).toBe(0);
  expect(calls).toContain("systemctl --user restart fleet-cli-proxy.service");
  calls.length = 0;
  expect(await cliProxy("install", machine)).toBe(0);
  expect(calls).not.toContain("systemctl --user restart fleet-cli-proxy.service");
});

test("connect keeps Claude settings that change while it checks the proxy", async () => {
  const { machine, home } = client();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(home), JSON.stringify({ model: "opus" }));
  const fetch = machine.fetch;
  machine.fetch = async (input, init) => {
    writeFileSync(settingsFile(home), JSON.stringify({ model: "opus", permissions: { deny: ["Bash(rm:*)"] }, env: { MY_FLAG: "2" } }));
    return fetch(input, init);
  };
  expect(await cliProxy("connect", machine)).toBe(0);
  expect(readJson(settingsFile(home))).toEqual({ model: "opus", permissions: { deny: ["Bash(rm:*)"] }, env: { MY_FLAG: "2", ANTHROPIC_BASE_URL: proxyUrl }, apiKeyHelper: keyHelper });
});

test("connect waits for a forward that is still coming up, and gives up after a while", async () => {
  let refused = 3;
  const late = client();
  const fetch = late.machine.fetch;
  let slept = 0;
  late.machine.sleep = async () => void slept++;
  late.machine.fetch = async (input, init) => (refused-- > 0 ? Promise.reject(new TypeError("connection refused")) : fetch(input, init));
  expect(await cliProxy("connect", late.machine)).toBe(0);
  expect(slept).toBe(3);
  expect(readFileSync(keyFile(late.home), "utf8")).toBe(`${clientKey}\n`);

  const never = client({}, { down: true });
  await expect(cliProxy("connect", never.machine)).rejects.toThrow("Nothing changed");
  expect(never.requests.length).toBeGreaterThan(1);
  expect(never.requests.length).toBeLessThanOrEqual(30);

  const refusedKey = client({ readStdin: async () => `${otherKey}\n` });
  await expect(cliProxy("connect", refusedKey.machine)).rejects.toThrow("refuses this machine's key");
  expect(refusedKey.requests).toHaveLength(1);
});

test("the Claude switch stops and keeps your edit when settings change between its read and its write", async () => {
  const home = roleHome(temp.make("fleet-cli-proxy-"), "devbox");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(home), JSON.stringify({ model: "opus" }));
  const write = (await claudeRoute(home, true))!;
  writeFileSync(settingsFile(home), JSON.stringify({ model: "opus", permissions: { deny: ["Bash(rm:*)"] } }));
  await expect(write()).rejects.toThrow("changed while Fleet wrote it");
  expect(readJson(settingsFile(home))).toEqual({ model: "opus", permissions: { deny: ["Bash(rm:*)"] } });
  expect(readdirSync(join(home, ".claude"))).toEqual(["settings.json"]);
});

test("an install that stops after it replaced the binary restarts the proxy on the next run", async () => {
  const { machine, home, calls } = hubMachine();
  expect(await cliProxy("install", machine)).toBe(0);
  const binary = join(dataDir(home), "cli-proxy-api");
  machine.release = { ...release, version: "9.9.10" };
  let crash = true;
  const run = machine.run;
  machine.run = async (command, options) => {
    if (command[0] === binary) return { code: 0, stdout: `CLIProxyAPI Version: ${readFileSync(binary, "utf8")}, Commit: x\n`, stderr: "" };
    if (command[0] === "install") {
      writeFileSync(command.at(-1)!, "9.9.10");
      if (crash) return (crash = false), { code: 1, stdout: "", stderr: "killed" };
      return { code: 0, stdout: "", stderr: "" };
    }
    return run(command, options);
  };
  await expect(cliProxy("install", machine)).rejects.toThrow();
  calls.length = 0;
  expect(await cliProxy("install", machine)).toBe(0);
  expect(calls).toContain("systemctl --user restart fleet-cli-proxy.service");
});
