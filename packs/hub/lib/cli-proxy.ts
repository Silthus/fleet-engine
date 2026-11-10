import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { management, managementFile, managementPattern, proxyDir, proxyUrl, readManagementKey } from "./cli-proxy-balance.ts";
import { requireHubRole } from "./hub-job.ts";
import { quote, readRole, remoteFleet } from "./machine.ts";
import { changedFiles, readIfThere, requireInstalled, writeFiles, type Managed } from "./managed.ts";
import { refuseLinks, writePrivateFile, type Fetch } from "../../mcp-gateway/lib/client.ts";
import type { Run } from "../../mcp-gateway/lib/hub.ts";
import { isBoxName } from "./names.ts";
import { must, proxyPort } from "./run.ts";

export { proxyPort, proxyUrl };
export type ProxyMode = "plan" | "install" | "doctor" | "connect" | "disconnect" | "check";
export type Release = { version: string; url: string; sha256: string };
export type AiPlan = "claude" | "codex" | "both";
export type ProxyMachine = {
  home: string; uid: number; user: string; plan?: AiPlan; accounts?: number; devboxes: string[]; release: Release; run: Run; fetch: Fetch;
  sleep(ms: number): Promise<void>; readStdin(): Promise<string>; randomKey(): string; print(line: string): void;
};

export const keyPath = (home: string) => join(home, ".config/fleet/cli-proxy.key");
export const keyHelper = 'cat "$HOME/.config/fleet/cli-proxy.key"';
const marker = "# Managed by Fleet CLI proxy.";
const what = "CLI proxy";
const service = "fleet-cli-proxy.service";
const keyPattern = /^([0-9a-f]{64})\n?$/;
const address = `127.0.0.1:${proxyPort}`;
const answerTries = 20;

function layout(home: string) {
  const dir = proxyDir(home);
  return { dir, binary: join(dir, "cli-proxy-api"), config: join(dir, "config.yaml"), auth: join(dir, "auth"), management: managementFile(home), unit: join(home, ".config/systemd/user", service), key: keyPath(home), restart: join(dir, "restart-pending") };
}
type Layout = ReturnType<typeof layout>;
const loginCommand = (paths: Layout, agent: Agent) => `${paths.binary} -config ${paths.config} -${agent}-login -no-browser`;
const pooled = (plan: AiPlan | undefined): Agent => (plan === "codex" ? "codex" : "claude");
const subscription = { claude: "Claude", codex: "Codex" };
const subscriptions = (count: number, agent: Agent) => `${count} ${subscription[agent]} subscription${count === 1 ? "" : "s"}`;

function wanted(paths: Layout, key: string): Managed[] {
  if (/["%\s\\]/.test(paths.dir)) throw new Error(`Move your home to a path without spaces, quotes, % or backslashes: ${paths.dir}`);
  const config = [
    marker, `host: "127.0.0.1"`, `port: ${proxyPort}`, "tls:", "  enable: false", "remote-management:", "  allow-remote: false", `  secret-key: ""`, "  disable-control-panel: true",
    `auth-dir: "${paths.auth}"`, "api-keys:", `  - "${key}"`, "debug: false", "commercial-mode: true", "logging-to-file: false", "usage-statistics-enabled: true", "request-retry: 3",
    "quota-exceeded:", "  switch-project: true", "  switch-preview-model: true", "routing:", `  strategy: "fill-first"`, "  session-affinity: true", `  session-affinity-ttl: "1h"`, "",
  ].join("\n");
  const unit = [
    marker, "[Unit]", "Description=Fleet CLI proxy for your own subscriptions", "After=network-online.target", "Wants=network-online.target", "", "[Service]",
    `EnvironmentFile=${paths.management}`, `ExecStart=${paths.binary} -config ${paths.config}`, `WorkingDirectory=${paths.dir}`, "UMask=0077", "Restart=on-failure", "RestartSec=5", "NoNewPrivileges=true",
    "", "[Install]", "WantedBy=default.target", "",
  ].join("\n");
  return [{ path: paths.config, content: config }, { path: paths.unit, content: unit }];
}

async function readSecret(home: string, path: string, pattern: RegExp): Promise<string | undefined> {
  await refuseLinks(home, path, `${what} path`);
  const text = await readIfThere(path);
  if (text === undefined) return undefined;
  const value = pattern.exec(text)?.[1];
  if (!value) throw new Error(`Keep unmanaged ${what} file: ${path}`);
  return value;
}

async function savedKey(home: string): Promise<string | undefined> {
  await refuseLinks(home, keyPath(home), `${what} path`);
  return keyPattern.exec((await readIfThere(keyPath(home))) ?? "")?.[1];
}

async function binaryReady(machine: ProxyMachine, paths: Layout): Promise<boolean> {
  const help = await machine.run([paths.binary, "--help"]);
  return `${help.stdout}${help.stderr}`.includes(`CLIProxyAPI Version: ${machine.release.version}`);
}

async function ensureBinary(machine: ProxyMachine, paths: Layout): Promise<void> {
  if (await binaryReady(machine, paths)) return;
  await writePrivateFile(paths.restart, "\n");
  const folder = await mkdtemp(join(tmpdir(), "fleet-cli-proxy-"));
  try {
    const archive = join(folder, "release.tar.gz");
    await must(machine.run, ["curl", "-fsSL", machine.release.url, "-o", archive]);
    if (new Bun.CryptoHasher("sha256").update(await readFile(archive)).digest("hex") !== machine.release.sha256) throw new Error(`Checksum mismatch for ${machine.release.url}.`);
    await must(machine.run, ["tar", "-xzf", archive, "-C", folder]);
    await must(machine.run, ["install", "-m", "0755", join(folder, "cli-proxy-api"), paths.binary]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function refuseLinkedLayout(home: string, paths: Layout): Promise<void> {
  for (const path of [paths.auth, paths.binary, paths.config, paths.management, paths.restart, paths.unit, paths.key]) await refuseLinks(home, path, `${what} path`);
}

async function install(machine: ProxyMachine, paths: Layout): Promise<void> {
  await refuseLinkedLayout(machine.home, paths);
  const savedClient = await readSecret(machine.home, paths.key, keyPattern);
  const savedManagement = await readSecret(machine.home, paths.management, managementPattern);
  const key = savedClient ?? machine.randomKey();
  const managementKey = savedManagement ?? machine.randomKey();
  const changed = await changedFiles(machine.home, wanted(paths, key), marker, what);
  for (const dir of [paths.dir, paths.auth, dirname(paths.key)]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  if (changed.length || !savedManagement) await writePrivateFile(paths.restart, "\n");
  await ensureBinary(machine, paths);
  if (!savedClient) await writePrivateFile(paths.key, `${key}\n`);
  if (!savedManagement) await writePrivateFile(paths.management, `MANAGEMENT_PASSWORD=${managementKey}\n`);
  await writeFiles(changed);
  await must(machine.run, ["sudo", "-n", "loginctl", "enable-linger", machine.user]);
  const systemctl = (...args: string[]) => must(machine.run, ["systemctl", "--user", ...args]);
  await systemctl("daemon-reload");
  if ((await readIfThere(paths.restart)) !== undefined) await systemctl("restart", service);
  await rm(paths.restart, { force: true });
  await systemctl("enable", "--now", service);
}

async function doctor(machine: ProxyMachine, paths: Layout): Promise<void> {
  await refuseLinkedLayout(machine.home, paths);
  const key = await readSecret(machine.home, paths.key, keyPattern);
  if (!key) throw new Error(`${paths.key} holds no proxy key. Run fleet cli-proxy install.`);
  const managementKey = await readManagementKey(machine.home);
  await requireInstalled(machine.home, wanted(paths, key), marker, what, "fleet cli-proxy install");
  if (!(await binaryReady(machine, paths))) throw new Error(`CLIProxyAPI ${machine.release.version} is not installed. Run fleet cli-proxy install.`);
  for (const check of ["is-enabled", "is-active"]) await must(machine.run, ["systemctl", "--user", check, "--quiet", service]);
  const listeners = async () => (await must(machine.run, ["ss", "-H", "-ltn", `sport = :${proxyPort}`])).trim().split("\n").filter(Boolean).map((line) => line.split(/\s+/)[3]);
  for (let attempt = 0; attempt < 50 && !(await listeners()).includes(address); attempt++) await machine.sleep(100);
  const bound = await listeners();
  if (!bound.includes(address) || bound.some((local) => local !== address)) throw new Error(`The CLI proxy must listen on loopback only, at ${address}.`);
  const strategy = ((await management(machine.fetch, managementKey, "routing/strategy")) as { strategy?: string }).strategy;
  if (strategy !== "fill-first") throw new Error(`The proxy routes with ${strategy ?? "no strategy"}, not fill-first. Run fleet cli-proxy-balance to restore it.`);
  const { files } = (await management(machine.fetch, managementKey, "auth-files")) as { files: Array<{ provider?: string; disabled?: boolean }> };
  const enabled = (agent: Agent) => files.filter((file) => file.provider === agent && !file.disabled).length;
  const agent = pooled(machine.plan);
  const count = enabled(agent);
  const floor = machine.accounts ?? 2;
  if (count < floor) throw new Error(`Add at least ${floor} of your own ${subscription[agent]} subscriptions; found ${count}. Run: ${loginCommand(paths, agent)}`);
  const reason = await probe(machine.fetch, key, agent);
  if (reason) throw new Error(reason);
  const beside = machine.plan === "both" ? ` and ${subscriptions(enabled("codex"), "codex")}` : "";
  const balancer = agent === "claude" ? "puts the one whose weekly quota resets first on top" : "frees each one whose quota cooldown its live usage disproves";
  machine.print(`CLI proxy: CLIProxyAPI ${machine.release.version} runs at ${proxyUrl}, loopback only, with ${count} of your own ${subscription[agent]} subscriptions${beside}. Every 5 minutes the balancer ${balancer}.`);
  for (const devbox of machine.devboxes.filter((name) => !isBoxName(name))) machine.print(`Connect ${devbox}: ssh ${devbox} ${quote(remoteFleet("cli-proxy connect"))} < ~/.config/fleet/cli-proxy.key`);
}

const silent = `The proxy at ${proxyUrl} does not answer.`;

async function listModels(fetch: Fetch, key: string): Promise<string[] | string> {
  const response = await fetch(`${proxyUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  if (!response) return silent;
  if (!response.ok) return `The proxy at ${proxyUrl} refuses this machine's key (HTTP ${response.status}).`;
  return (((await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> }).data ?? []).flatMap((model) => (typeof model.id === "string" ? [model.id] : []));
}

const servedModel = { claude: (id: string) => id.includes("claude"), codex: (id: string) => id.startsWith("gpt-") };
const missingModel = {
  claude: `The proxy at ${proxyUrl} lists no Claude model. On the hub, run fleet cli-proxy doctor.`,
  codex: `The proxy at ${proxyUrl} lists no Codex model. Add one of your own Codex subscriptions to the hub's proxy.`,
};

function unserved(models: string[] | string, provider: "claude" | "codex"): string | undefined {
  if (typeof models === "string") return models;
  return models.some(servedModel[provider]) ? undefined : missingModel[provider];
}

const probe = async (fetch: Fetch, key: string, agent: Agent) => unserved(await listModels(fetch, key), agent);

async function answered(machine: ProxyMachine, key: string, agent: Agent): Promise<string | undefined> {
  let reason = await probe(machine.fetch, key, agent);
  for (let attempt = 1; attempt < answerTries && reason === silent; attempt++) {
    await machine.sleep(1000);
    reason = await probe(machine.fetch, key, agent);
  }
  return reason;
}

type Settings = Record<string, unknown> & { env?: Record<string, unknown> };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export async function claudeRoute(home: string, on: boolean): Promise<(() => Promise<void>) | undefined> {
  const path = join(home, ".claude/settings.json");
  await refuseLinks(home, path, "Claude settings path");
  const text = await readIfThere(path);
  if (text === undefined && !on) return undefined;
  const settings = text === undefined ? {} : (JSON.parse(text) as Settings);
  if (!isObject(settings) || (settings.env !== undefined && !isObject(settings.env))) throw new Error(`${path} is not a Claude settings object. Fix it, then run this again.`);
  const before = JSON.stringify(settings);
  const env = settings.env ?? {};
  if (on) {
    for (const [name, current, value] of [["env.ANTHROPIC_BASE_URL", env.ANTHROPIC_BASE_URL, proxyUrl], ["apiKeyHelper", settings.apiKeyHelper, keyHelper]]) {
      if (current !== undefined && current !== value) throw new Error(`Keep your Claude setting ${name} in ${path}: Fleet did not set it. Remove it to use the proxy.`);
    }
    settings.env = { ...env, ANTHROPIC_BASE_URL: proxyUrl };
    settings.apiKeyHelper = keyHelper;
  } else {
    if (env.ANTHROPIC_BASE_URL === proxyUrl) delete env.ANTHROPIC_BASE_URL;
    if (settings.env && !Object.keys(env).length) delete settings.env;
    if (settings.apiKeyHelper === keyHelper) delete settings.apiKeyHelper;
  }
  if (JSON.stringify(settings) === before) return async () => {};
  return () => replaceUnchanged(path, text, `${JSON.stringify(settings, null, 2)}\n`);
}

async function replaceUnchanged(path: string, before: string | undefined, after: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const partial = `${path}.${randomUUID()}.partial`;
  await writeFile(partial, after, { mode: 0o600, flag: "wx" });
  try {
    if ((existsSync(path) ? readFileSync(path, "utf8") : undefined) !== before) throw new Error(`${path} changed while Fleet wrote it. Run this again.`);
    renameSync(partial, path);
  } finally {
    rmSync(partial, { force: true });
  }
}

const sendClaude = async (home: string, on: boolean) => (await claudeRoute(home, on))?.();

export const codexProvider = "fleet-proxy";
const codexUrl = `${proxyUrl}/v1`;
export const codexProviderTable = { name: "Fleet CLI proxy", base_url: codexUrl, wire_api: "responses", auth: { command: "/bin/sh", args: ["-c", keyHelper] } };

async function readCodex(home: string) {
  const path = join(home, ".codex/config.toml");
  await refuseLinks(home, path, "Codex config path");
  const text = await readIfThere(path);
  let config: unknown = {};
  try { if (text !== undefined) config = parse(text); }
  catch { config = undefined; }
  if (!isObject(config) || (config.model_providers !== undefined && !isObject(config.model_providers))) throw new Error(`${path} is not a Codex config. Fix it, then run this again.`);
  const providers = config.model_providers as Record<string, unknown> | undefined;
  const table = providers?.[codexProvider];
  const url = isObject(table) ? table.base_url : undefined;
  const routed = config.model_provider === codexProvider && (url === undefined || url === codexUrl);
  return { path, text, config, providers, routed, untouched: Bun.deepEquals(table, codexProviderTable) };
}

const readableCodex = (home: string) => readCodex(home).catch(() => undefined);

async function sendCodexHome(home: string): Promise<boolean> {
  const read = await readableCodex(home);
  if (!read) return false;
  const { path, text, config, providers, routed, untouched } = read;
  if (routed) delete config.model_provider;
  if (untouched) delete providers![codexProvider];
  if (providers && !Object.keys(providers).length) delete config.model_providers;
  if (routed || untouched) await replaceUnchanged(path, text, Object.keys(config).length ? `${stringify(config)}\n` : "");
  return routed;
}

export type Agent = "claude" | "codex";

async function check(machine: ProxyMachine, agent: Agent): Promise<boolean> {
  const key = await savedKey(machine.home);
  const models = key ? await listModels(machine.fetch, key) : `This machine has no proxy key at ${keyPath(machine.home)}. On the hub, fleet cli-proxy doctor prints the connect command.`;
  const reason = agent === "claude" ? unserved(models, "claude") : await codexUnserved(machine.home, models);
  const name = agent === "claude" ? "Claude Code" : "Codex";
  machine.print(reason ? `${reason} fleet apply keeps ${name} on its own sign-in until the proxy serves it.` : `${name} reaches your own-account proxy at ${proxyUrl}.`);
  return !reason;
}

async function codexUnserved(home: string, models: string[] | string): Promise<string | undefined> {
  const config = await readableCodex(home);
  const table = config?.providers?.[codexProvider];
  if (table !== undefined && !(isObject(table) && table.base_url === codexUrl)) return `${config!.path} has its own ${codexProvider} provider table, which does not use the proxy's base_url.`;
  return unserved(models, "codex");
}

async function connect(machine: ProxyMachine): Promise<void> {
  if (readRole(machine.home) === "hub") throw new Error("The hub has its own key. Run fleet cli-proxy install there.");
  const key = (await machine.readStdin()).trim();
  if (!keyPattern.test(key)) throw new Error("Pass the proxy key from the hub on standard input: 64 hexadecimal characters.");
  const agent = pooled(machine.plan);
  if (agent === "claude") await claudeRoute(machine.home, true);
  const reason = await answered(machine, key, agent);
  if (reason) throw new Error(`${reason} Nothing changed.`);
  await refuseLinks(machine.home, keyPath(machine.home), `${what} path`);
  await mkdir(dirname(keyPath(machine.home)), { recursive: true, mode: 0o700 });
  await writePrivateFile(keyPath(machine.home), `${key}\n`);
  if (agent === "codex") return machine.print(`Codex can reach your own-account proxy at ${proxyUrl} now. Run fleet apply to send Codex to the proxy, then restart open Codex sessions.`);
  await sendClaude(machine.home, true);
  machine.print(`Claude Code uses your own-account proxy at ${proxyUrl} now. Restart open Claude Code sessions.`);
}

async function disconnect(machine: ProxyMachine): Promise<void> {
  if (readRole(machine.home) === "hub") throw new Error("On the hub, turn the workflow off instead: fleet packs --workflows own-account-balancing=off");
  await sendClaude(machine.home, false);
  const codex = await sendCodexHome(machine.home);
  await refuseLinks(machine.home, keyPath(machine.home), `${what} path`);
  await rm(keyPath(machine.home), { force: true });
  machine.print("Claude Code no longer uses the proxy. To sign in again, run claude and enter /login, then restart open Claude Code sessions.");
  if (codex) machine.print("Codex no longer uses the proxy. To sign in again, run codex login, then restart open Codex sessions.");
  machine.print("fleet apply keeps this machine on its own sign-in while it has no proxy key.");
}

async function plan(machine: ProxyMachine, paths: Layout): Promise<void> {
  if (readRole(machine.home) !== "hub") {
    const key = await savedKey(machine.home);
    return machine.print(key ? `CLI proxy plan (no changes): Claude Code uses the proxy at ${proxyUrl} through the hub's tunnel.` : "CLI proxy plan (no changes): this machine has no proxy key. On the hub, fleet cli-proxy doctor prints the connect command.");
  }
  machine.print("CLI proxy plan (no changes):");
  if (!(await binaryReady(machine, paths))) machine.print(`  Install CLIProxyAPI ${machine.release.version} at ${paths.binary}.`);
  machine.print(`  Run it at ${proxyUrl}, loopback only, with fill-first routing and session affinity, as ${service}.`);
  machine.print(`  Keep the client key in ${paths.key} and the management key in ${paths.management}, both mode 600.`);
  const agent = pooled(machine.plan);
  machine.print(agent === "claude" ? "  Every 5 minutes, fleet cli-proxy-balance puts the subscription whose weekly quota resets first on top." : "  Every 5 minutes, fleet cli-proxy-balance frees each subscription whose quota cooldown its live usage disproves.");
  machine.print(`  Add at least ${machine.accounts ?? 2} of your own ${subscription[agent]} subscriptions with: ${loginCommand(paths, agent)}`);
}

export async function cliProxy(mode: ProxyMode, machine: ProxyMachine, agent: Agent = "claude"): Promise<number> {
  if (machine.uid === 0) throw new Error("Run fleet cli-proxy as the person who runs Claude Code, not root.");
  const paths = layout(machine.home);
  if (mode === "install" || mode === "doctor") requireHubRole(machine.home, `cli-proxy ${mode}`);
  if (mode === "plan") await plan(machine, paths);
  if (mode === "install") await install(machine, paths);
  if (mode === "doctor") await doctor(machine, paths);
  if (mode === "connect") await connect(machine);
  if (mode === "disconnect") await disconnect(machine);
  if (mode === "check") return (await check(machine, agent)) ? 0 : 1;
  return 0;
}
