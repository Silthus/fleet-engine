import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
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
const codexFile = (home: string) => join(home, ".codex/config.toml");
const readCodex = (home: string) => parse(readFileSync(codexFile(home), "utf8"));
const fleetProxy = { name: "Fleet CLI proxy", base_url: `${proxyUrl}/v1`, wire_api: "responses", auth: { command: "/bin/sh", args: ["-c", 'cat "$HOME/.config/fleet/cli-proxy.key"'] } };
const mine = { model: "gpt-6.1-sol", model_providers: { work: { name: "Work gateway", base_url: "https://gateway.example.com/v1" } } };

function codexRouted(home: string, config: Record<string, unknown> = { ...mine, model_provider: "fleet-proxy", model_providers: { ...mine.model_providers, "fleet-proxy": fleetProxy } }) {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(codexFile(home), stringify(config));
}

type Proxy = { strategy?: string; credentials?: Array<{ name?: string; provider: string; disabled?: boolean; status_message?: string }>; models?: string[]; down?: boolean };

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

test("install presents a current Claude Code version upstream, so new Claude models answer, and moves a hub on the older config to it", async () => {
  const { machine, home } = hubMachine();
  expect(await cliProxy("install", machine)).toBe(0);
  const configPath = join(dataDir(home), "config.yaml");
  const header = 'claude-header-defaults:\n  user-agent: "claude-cli/2.1.322 (external, cli)"\n';
  expect(readFileSync(configPath, "utf8")).toContain(header);
  expect((Bun.YAML.parse(readFileSync(configPath, "utf8")) as Record<string, Record<string, string>>)["claude-header-defaults"]).toEqual({ "user-agent": "claude-cli/2.1.322 (external, cli)" });

  writeFileSync(configPath, readFileSync(configPath, "utf8").replace(header, ""));
  const older = hubMachine({ home });
  expect(await cliProxy("install", older.machine)).toBe(0);
  expect(readFileSync(configPath, "utf8")).toContain(header);
  expect(older.calls).toContain("systemctl --user restart fleet-cli-proxy.service");
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

test("the doctor passes but warns about each subscription whose login expired, and names the sign-in command for its provider", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const expired = '{"error":"invalid_grant","error_description":"refresh token for alice expired"}';
  const credentials = [
    { name: "one.json", provider: "claude" },
    { name: "two.json", provider: "claude", status_message: expired },
    { name: "three.json", provider: "claude", status_message: "usage read timed out for alice" },
    { name: "work.json", provider: "codex", status_message: expired },
    { name: "old.json", provider: "claude", disabled: true, status_message: expired },
  ];
  const doctor = hubMachine({ home, plan: "both" }, { credentials, models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  expect(await cliProxy("doctor", doctor.machine)).toBe(0);
  const warnings = doctor.printed.filter((line) => line.includes("Warning"));
  const login = (agent: string) => `${join(dataDir(home), "cli-proxy-api")} -config ${join(dataDir(home), "config.yaml")} -${agent}-login -no-browser`;
  expect(warnings).toEqual([
    `CLI proxy: Warning: the Claude subscription two.json cannot refresh its login, so the proxy cannot use it and the balancer cannot read its usage. Sign it in again with: ${login("claude")}. Or disable it in the management panel.`,
    `CLI proxy: Warning: the Codex subscription work.json cannot refresh its login, so the proxy cannot use it and the balancer cannot read its usage. Sign it in again with: ${login("codex")}. Or disable it in the management panel.`,
  ]);
  expect(doctor.printed.join("\n")).not.toContain("alice");
});

test("on the Codex plan the doctor counts Codex subscriptions and wants a Codex model, and names the Codex login", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const codexOnly = { credentials: [{ provider: "codex" }, { provider: "codex" }], models: ["gpt-6.1-sol"] };
  const passing = hubMachine({ home, plan: "codex" }, codexOnly);
  expect(await cliProxy("doctor", passing.machine)).toBe(0);
  expect(passing.printed.join("\n")).toContain("with 2 of your own Codex subscriptions");
  const few = hubMachine({ home, plan: "codex" }, { credentials: [{ provider: "codex" }, { provider: "claude" }, { provider: "claude" }], models: ["gpt-6.1-sol"] });
  await expect(cliProxy("doctor", few.machine)).rejects.toThrow(`Add at least 2 of your own Codex subscriptions; found 1. Run: ${join(dataDir(home), "cli-proxy-api")} -config ${join(dataDir(home), "config.yaml")} -codex-login -no-browser`);
  const noModel = hubMachine({ home, plan: "codex" }, { credentials: codexOnly.credentials });
  await expect(cliProxy("doctor", noModel.machine)).rejects.toThrow("lists no Codex model");
});

test("on the both plan the doctor still asks for Claude subscriptions, and counts the Codex ones beside them", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const both = hubMachine({ home, plan: "both" }, { credentials: [{ provider: "claude" }, { provider: "claude" }, { provider: "codex" }], models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  expect(await cliProxy("doctor", both.machine)).toBe(0);
  expect(both.printed.join("\n")).toContain("with 2 of your own Claude subscriptions and 1 Codex subscription");
  const claudeOnly = hubMachine({ home, plan: "claude" }, { credentials: [{ provider: "claude" }, { provider: "claude" }, { provider: "codex" }] });
  expect(await cliProxy("doctor", claudeOnly.machine)).toBe(0);
  expect(claudeOnly.printed.join("\n")).toContain("with 2 of your own Claude subscriptions.");
});

test("connect on a Codex plan checks the proxy for a Codex model, sends Codex to the proxy, and leaves Claude Code alone", async () => {
  const { machine, home, printed } = client({ plan: "codex" }, { models: ["gpt-6.1-sol"] });
  codexRouted(home, mine);
  expect(await cliProxy("connect", machine)).toBe(0);
  expect(readFileSync(keyFile(home), "utf8")).toBe(`${clientKey}\n`);
  expect(readCodex(home)).toEqual({ ...mine, model_provider: "fleet-proxy", model_providers: { ...mine.model_providers, "fleet-proxy": fleetProxy } });
  expect(existsSync(settingsFile(home))).toBe(false);
  expect(printed).toEqual([`Codex uses your own-account proxy at ${proxyUrl} now. Restart open Codex sessions.`]);
  expect(await cliProxy("check", machine, "codex")).toBe(0);

  const noCodex = client({ plan: "codex" });
  await expect(cliProxy("connect", noCodex.machine)).rejects.toThrow("lists no Codex model. Add one of your own Codex subscriptions to the hub's proxy. Nothing changed.");
  expect(existsSync(keyFile(noCodex.home))).toBe(false);
  expect(existsSync(codexFile(noCodex.home))).toBe(false);

  const theirs = client({ plan: "codex" }, { models: ["gpt-6.1-sol"] });
  codexRouted(theirs.home, { ...mine, model_provider: "work" });
  await expect(cliProxy("connect", theirs.machine)).rejects.toThrow("Keep your Codex setting model_provider");
  expect(readCodex(theirs.home)).toEqual({ ...mine, model_provider: "work" });
  expect(existsSync(keyFile(theirs.home))).toBe(false);
});

test("connect on the both plan sends Claude Code to the proxy, and Codex too while the proxy serves it", async () => {
  const served = client({ plan: "both" }, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  expect(await cliProxy("connect", served.machine)).toBe(0);
  expect(readJson(settingsFile(served.home)).apiKeyHelper).toBe(keyHelper);
  expect(readCodex(served.home)).toEqual({ model_provider: "fleet-proxy", model_providers: { "fleet-proxy": fleetProxy } });

  const claudeOnly = client({ plan: "both" });
  expect(await cliProxy("connect", claudeOnly.machine)).toBe(0);
  expect(readJson(settingsFile(claudeOnly.home)).apiKeyHelper).toBe(keyHelper);
  expect(existsSync(codexFile(claudeOnly.home))).toBe(false);
  expect(claudeOnly.printed.join("\n")).toContain("lists no Codex model. Add one of your own Codex subscriptions to the hub's proxy. Codex keeps its own sign-in.");
});

test("connect never selects a fleet-proxy table that cannot reach the proxy with this machine's key", async () => {
  const { auth: _auth, ...keyless } = fleetProxy;
  const config = { model_providers: { "fleet-proxy": keyless } };
  const codexOnly = client({ plan: "codex" }, { models: ["gpt-6.1-sol"] });
  codexRouted(codexOnly.home, config);
  await expect(cliProxy("connect", codexOnly.machine)).rejects.toThrow("which does not reach the proxy with this machine's key. Nothing changed.");
  expect(readCodex(codexOnly.home)).toEqual(config);
  expect(existsSync(keyFile(codexOnly.home))).toBe(false);

  const both = client({ plan: "both" }, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  codexRouted(both.home, config);
  expect(await cliProxy("connect", both.machine)).toBe(0);
  expect(readCodex(both.home)).toEqual(config);
  expect(both.printed.join("\n")).toContain("Codex keeps its own sign-in.");
});

test("on the both plan, a Codex config that connect cannot write keeps Codex on its own sign-in, and Claude Code still connects", async () => {
  const { machine, home, printed } = client({ plan: "both" }, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  codexRouted(home, mine);
  chmodSync(join(home, ".codex"), 0o500);
  try {
    expect(await cliProxy("connect", machine)).toBe(0);
  } finally {
    chmodSync(join(home, ".codex"), 0o700);
  }
  expect(readJson(settingsFile(home)).apiKeyHelper).toBe(keyHelper);
  expect(readCodex(home)).toEqual(mine);
  expect(printed.at(-1)).toEndWith("Codex keeps its own sign-in.");
});

test("connect leaves a Codex config that becomes a link while it checks the proxy", async () => {
  const { machine, home, printed } = client({ plan: "both" }, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  codexRouted(home, mine);
  const outside = temp.make("elsewhere-");
  writeFileSync(join(outside, "config.toml"), readFileSync(codexFile(home), "utf8"));
  const fetch = machine.fetch;
  machine.fetch = async (input, init) => {
    if (!existsSync(join(home, ".codex", "moved"))) {
      rmSync(join(home, ".codex"), { recursive: true });
      symlinkSync(outside, join(home, ".codex"));
      writeFileSync(join(outside, "moved"), "");
    }
    return fetch(input, init);
  };
  expect(await cliProxy("connect", machine)).toBe(0);
  expect(parse(readFileSync(join(outside, "config.toml"), "utf8"))).toEqual(mine);
  expect(printed.at(-1)).toEndWith("Codex keeps its own sign-in.");
});

test("on a devbox, plan names the agents that the plan sends through the proxy", async () => {
  for (const [ai, agents] of [["claude", "Claude Code uses"], ["codex", "Codex uses"], ["both", "Claude Code and Codex use"]] as const) {
    const { machine, home, printed } = client({ plan: ai });
    connected(home);
    expect(await cliProxy("plan", machine)).toBe(0);
    expect(printed).toEqual([`CLI proxy plan (no changes): this machine has a proxy key, and ${agents} the proxy at ${proxyUrl} through the hub's tunnel while the proxy serves them.`]);
  }
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

test("the check reports an unreachable proxy and changes no file: apply sends Claude Code back to its own sign-in", async () => {
  const { machine, home, printed } = client({}, { down: true });
  connected(home);
  const before = readFileSync(settingsFile(home), "utf8");
  expect(await cliProxy("check", machine)).toBe(1);
  expect(readFileSync(settingsFile(home), "utf8")).toBe(before);
  expect(printed).toEqual([`The proxy at ${proxyUrl} does not answer. fleet apply keeps Claude Code on its own sign-in until the proxy serves it.`]);
  expect(existsSync(keyFile(home))).toBe(true);
});

test("the check fails without a saved key, or when the proxy serves no Claude model, and writes nothing", async () => {
  const missing = client();
  connected(missing.home);
  writeFileSync(keyFile(missing.home), "");
  expect(await cliProxy("check", missing.machine)).toBe(1);
  expect(readJson(settingsFile(missing.home)).apiKeyHelper).toBe(keyHelper);
  expect(missing.printed.join("\n")).toContain("no proxy key");

  const refused = client({}, { models: ["gpt-6.1-sol"] });
  connected(refused.home);
  expect(await cliProxy("check", refused.machine)).toBe(1);
  expect(refused.printed.join("\n")).toContain("lists no Claude model");

  const fresh = client({}, { down: true });
  expect(await cliProxy("check", fresh.machine)).toBe(1);
  expect(existsSync(settingsFile(fresh.home))).toBe(false);
});

test("disconnect removes only Fleet's own values: a base URL or key helper you set stays", async () => {
  const { machine, home } = client();
  connected(home);
  writeFileSync(settingsFile(home), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" }, apiKeyHelper: "my-helper" }));
  expect(await cliProxy("disconnect", machine)).toBe(0);
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

test("a linked Claude settings file stops connect and disconnect", async () => {
  const { machine, home } = client();
  connected(home);
  const real = join(temp.make("real-"), "settings.json");
  writeFileSync(real, readFileSync(settingsFile(home)));
  rmSync(settingsFile(home));
  symlinkSync(real, settingsFile(home));
  await expect(cliProxy("disconnect", machine)).rejects.toThrow("Keep linked Claude settings path");
  await expect(cliProxy("connect", machine)).rejects.toThrow("Keep linked Claude settings path");
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

test("the Codex check keeps Codex on the proxy while the proxy lists a Codex model, and says so", async () => {
  const { machine, home, printed } = client({}, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  connected(home);
  codexRouted(home);
  expect(await cliProxy("check", machine, "codex")).toBe(0);
  expect(readCodex(home)).toMatchObject({ model_provider: "fleet-proxy", model_providers: { "fleet-proxy": fleetProxy } });
  expect(printed).toEqual([`Codex reaches your own-account proxy at ${proxyUrl}.`]);
});

test("the Codex check judges the proxy before Fleet routes Codex, so apply can wait for it", async () => {
  const served = client({}, { models: ["gpt-6.1-sol"] });
  connected(served.home);
  expect(await cliProxy("check", served.machine, "codex")).toBe(0);
  expect(existsSync(codexFile(served.home))).toBe(false);
  const unserved = client();
  connected(unserved.home);
  expect(await cliProxy("check", unserved.machine, "codex")).toBe(1);
  expect(existsSync(codexFile(unserved.home))).toBe(false);
});

test("the Codex check reports an unreachable proxy and changes no file", async () => {
  const { machine, home, printed } = client({}, { down: true });
  connected(home);
  codexRouted(home);
  const before = readFileSync(codexFile(home), "utf8");
  expect(await cliProxy("check", machine, "codex")).toBe(1);
  expect(readFileSync(codexFile(home), "utf8")).toBe(before);
  expect(printed.join("\n")).toContain("fleet apply keeps Codex on its own sign-in until the proxy serves it.");
});

test("a proxy that lists no Codex model fails only the Codex check", async () => {
  const { machine, home, printed } = client();
  connected(home);
  codexRouted(home);
  expect(await cliProxy("check", machine)).toBe(0);
  expect(await cliProxy("check", machine, "codex")).toBe(1);
  expect(printed.join("\n")).toContain(`The proxy at ${proxyUrl} lists no Codex model.`);
});

test("without a saved key, the Codex check fails", async () => {
  const { machine, home, printed } = client({}, { models: ["gpt-6.1-sol"] });
  codexRouted(home);
  expect(await cliProxy("check", machine, "codex")).toBe(1);
  expect(printed.join("\n")).toContain("no proxy key");
});

test("Codex that does not use Fleet's proxy is left alone by both checks", async () => {
  const own = client({}, { down: true });
  connected(own.home);
  codexRouted(own.home, { ...mine, model_provider: "work" });
  expect(await cliProxy("check", own.machine, "codex")).toBe(1);
  expect(readCodex(own.home)).toEqual({ ...mine, model_provider: "work" });

  const edited = client({}, { down: true });
  connected(edited.home);
  codexRouted(edited.home, { model_provider: "fleet-proxy", model_providers: { "fleet-proxy": { ...fleetProxy, base_url: "https://gateway.example.com/v1" } } });
  expect(await cliProxy("check", edited.machine)).toBe(1);
  expect(await cliProxy("check", edited.machine, "codex")).toBe(1);
  expect(readCodex(edited.home)).toEqual({ model_provider: "fleet-proxy", model_providers: { "fleet-proxy": { ...fleetProxy, base_url: "https://gateway.example.com/v1" } } });
});

test("disconnect sends Codex back to its own sign-in too, and says how to sign in again", async () => {
  const { machine, home, printed } = client();
  connected(home);
  codexRouted(home);
  expect(await cliProxy("disconnect", machine)).toBe(0);
  expect(readCodex(home)).toEqual(mine);
  expect(printed.join("\n")).toContain("run codex login");
});

test("a linked or unreadable Codex config is left alone and never breaks the Claude route", async () => {
  const linked = client();
  connected(linked.home);
  mkdirSync(join(linked.home, ".codex"), { recursive: true });
  const real = join(temp.make("real-"), "config.toml");
  writeFileSync(real, stringify({ model_provider: "fleet-proxy", model_providers: { "fleet-proxy": fleetProxy } }));
  symlinkSync(real, codexFile(linked.home));
  expect(await cliProxy("check", linked.machine)).toBe(0);
  expect(await cliProxy("check", linked.machine, "codex")).toBe(1);
  expect(await cliProxy("disconnect", linked.machine)).toBe(0);
  expect(parse(readFileSync(real, "utf8"))).toEqual({ model_provider: "fleet-proxy", model_providers: { "fleet-proxy": fleetProxy } });

  const broken = client();
  connected(broken.home);
  mkdirSync(join(broken.home, ".codex"), { recursive: true });
  writeFileSync(codexFile(broken.home), "model = [");
  expect(await cliProxy("check", broken.machine)).toBe(0);
  expect(await cliProxy("check", broken.machine, "codex")).toBe(1);
  expect(readJson(settingsFile(broken.home)).env.ANTHROPIC_BASE_URL).toBe(proxyUrl);
  expect(readFileSync(codexFile(broken.home), "utf8")).toBe("model = [");
});

test("disconnect keeps a Fleet provider table you edited, and removes only Fleet's selection", async () => {
  const { machine, home } = client();
  connected(home);
  const edited = { ...fleetProxy, http_headers: { "X-Team": "mine" } };
  codexRouted(home, { model_provider: "fleet-proxy", model_providers: { "fleet-proxy": edited } });
  expect(await cliProxy("disconnect", machine)).toBe(0);
  expect(readCodex(home)).toEqual({ model_providers: { "fleet-proxy": edited } });
});

test("a fleet-proxy table that does not reach the proxy with this machine's key fails the Codex check, whether or not Codex selects it", async () => {
  const served = { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] };
  const { auth: _auth, ...keyless } = fleetProxy;
  const configs: Array<Record<string, unknown>> = [{ model_provider: "fleet-proxy", model_providers: { "fleet-proxy": { name: "Mine" } } }, { model_providers: { "fleet-proxy": { name: "Mine" } } }, { model_providers: { "fleet-proxy": { ...fleetProxy, base_url: "https://gateway.example.com/v1" } } }, { model_providers: { "fleet-proxy": keyless } }, { model_providers: { "fleet-proxy": { ...fleetProxy, wire_api: "chat" } } }];
  for (const config of configs) {
    const { machine, home, printed } = client({}, served);
    connected(home);
    codexRouted(home, config);
    expect(await cliProxy("check", machine, "codex")).toBe(1);
    expect(readCodex(home) as Record<string, unknown>).toEqual(config);
    expect(printed.join("\n")).toContain("has its own fleet-proxy provider table, which does not reach the proxy with this machine's key.");
  }
  const edited = client({}, served);
  connected(edited.home);
  codexRouted(edited.home, { model_providers: { "fleet-proxy": { ...fleetProxy, http_headers: { "X-Team": "mine" } } } });
  expect(await cliProxy("check", edited.machine, "codex")).toBe(0);
});

test("remove stops and deletes the proxy's unit, keeps its keys, config and subscriptions, and left then reports nothing left", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  expect(await cliProxy("left", machine)).toBe(0);
  const removing = hubMachine({ home });
  expect(await cliProxy("remove", removing.machine)).toBe(0);
  expect(removing.calls).toEqual(["systemctl --user disable --now fleet-cli-proxy.service", "systemctl --user daemon-reload"]);
  expect(existsSync(unitFile(home))).toBe(false);
  for (const path of [keyFile(home), join(dataDir(home), "management.env"), join(dataDir(home), "config.yaml"), join(dataDir(home), "auth")]) expect([path, existsSync(path)]).toEqual([path, true]);
  expect(await cliProxy("left", removing.machine)).toBe(1);
});
