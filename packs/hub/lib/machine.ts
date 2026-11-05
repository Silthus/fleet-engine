import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { numberSetting, optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import { withT3Session } from "../../base/lib/t3/index.ts";
import { capture, type Capture, type Env, type Result } from "./coder.ts";
import { writePrivateFile } from "./mcphub/client.ts";
import { isBoxName } from "./names.ts";
import type { Clock } from "./pool.ts";

export type BoxSettings = {
  alias: string; coderUrl: string; template: string; diskGigabytes: number; poolSize: number;
  idleHours: number; reapDays: number; keepDirs: string[]; relayPort: number; httpsHost?: string; warmCommand?: string;
};

export type PeerLinkInput = { url: string; alternateUrls: string[]; pairingCode: string; access: "full-access" };

export type PeerMachine = Clock & {
  home: string;
  self: string;
  peers: string[];
  devboxes: string[];
  onPeer(alias: string, command: string, stdin?: string): Promise<Result>;
  run(argv: string[], stdin?: string): Promise<Result>;
  freePort(): number;
  environmentId(url: string, timeoutMs: number): Promise<string | undefined>;
  linkEnvironment(input: PeerLinkInput): Promise<void>;
  print(line: string): void;
  say(line: string): void;
};

export type Machine = PeerMachine & { workspace: string; isHub: boolean; codex: boolean; settings: BoxSettings; toHub(args: string[]): Promise<number> };

export const shellLimitMs = 5 * 60_000;
export const hubCallLimitMs = 3 * 3_600_000;
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
export const peerSsh = (alias: string, command: string) => ["ssh", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "ConnectTimeout=10", alias, `bash -lc ${quote(command)}`];
export const remoteFleet = (args: string) => `sh "$HOME/.local/share/fleet/engine/fleet" ${args}`;
const machinePath = (home: string) => join(home, ".config/fleet/machine.json");

export function readBoxSettings(env: Env): BoxSettings {
  const warmCommand = optionalStringSetting("hub.boxWarmCommand", env);
  const httpsHost = optionalStringSetting("hub.httpsHost", env);
  return {
    alias: stringSetting("hub.alias", env),
    coderUrl: stringSetting("hub.coderUrl", env),
    template: stringSetting("hub.boxTemplate", env),
    diskGigabytes: numberSetting("hub.boxDiskGigabytes", env),
    poolSize: numberSetting("hub.boxPoolSize", env),
    idleHours: numberSetting("hub.boxIdleHours", env),
    reapDays: numberSetting("hub.boxReapDays", env),
    keepDirs: stringSetting("hub.boxKeepDirs", env).split(/\s+/).filter(Boolean),
    relayPort: numberSetting("hub.relayPort", env),
    ...(httpsHost ? { httpsHost } : {}),
    ...(warmCommand ? { warmCommand } : {}),
  };
}

export function peersOf(hub: string, devboxes: string[], self: string): string[] {
  return [...new Set([hub, ...devboxes])].filter((alias) => alias !== self);
}

function readMachineFile(home: string): Record<string, unknown> | undefined {
  const path = machinePath(home);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : undefined;
}

export function readRole(home: string): string | undefined {
  const role = readMachineFile(home)?.role;
  return typeof role === "string" ? role : undefined;
}

export async function markHub(home: string): Promise<void> {
  const machine = readMachineFile(home);
  if (!machine) throw new Error(`${machinePath(home)} does not exist. Run fleet setup on this machine first.`);
  await writePrivateFile(machinePath(home), JSON.stringify({ ...machine, role: "hub" }, null, 2) + "\n");
}

export function requireHub(home: string, command: string): void {
  const role = readRole(home);
  if (role === "hub") return;
  throw new Error(`fleet box ${command} runs only on the hub. This machine's role is ${role ?? "not set"}. Run fleet hub here on the hub, or run this there.`);
}

export type HubCommandIo = { home: string; settings: Record<string, unknown>; print(line: string): void };

export async function hubCommand(args: string[], io: HubCommandIo): Promise<number> {
  const [command, ...rest] = args;
  if (rest.length || (command !== "here" && command !== "status")) {
    io.print("Usage: fleet hub here     Make this machine the hub\n       fleet hub status   Print this machine's role and the hub's SSH name");
    return 2;
  }
  if (command === "here") {
    await markHub(io.home);
    io.print("This machine is the hub now. Run fleet apply to add the hub's jobs.");
    return 0;
  }
  io.print(`This machine's role: ${readRole(io.home) ?? "not set up"}`);
  io.print(`hub.alias: ${typeof io.settings["hub.alias"] === "string" ? io.settings["hub.alias"] : "not set"}`);
  return 0;
}

function readProfile(env: Env): { devboxes: string[]; plan?: string } {
  const path = env.FLEET_PROFILE_DIR ? join(env.FLEET_PROFILE_DIR, "fleet.json") : undefined;
  if (!path || !existsSync(path)) return { devboxes: [] };
  const profile = JSON.parse(readFileSync(path, "utf8")) as { devboxes?: string[]; plan?: string };
  return { devboxes: profile.devboxes ?? [], ...(profile.plan ? { plan: profile.plan } : {}) };
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

async function environmentId(url: string, timeoutMs: number): Promise<string | undefined> {
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
  const response = await fetch(`${url}/.well-known/t3/environment`, { signal }).catch(() => null);
  return response?.ok ? (((await response.json().catch(() => ({}))) as { environmentId?: string }).environmentId) : undefined;
}

function savedDevboxes(home: string): string[] {
  const saved = readMachineFile(home)?.devboxes;
  return Array.isArray(saved) ? saved.filter((host): host is string => typeof host === "string") : [];
}

function namesOfThisMachine(home: string, hub: string): string[] {
  const machine = readMachineFile(home);
  return [...(machine?.role === "hub" ? [hub] : []), ...(typeof machine?.name === "string" ? [machine.name] : [])];
}

export function shellsWith(run: Capture, hub: string): Pick<Machine, "onPeer" | "toHub" | "run"> {
  const input = (stdin?: string) => (stdin === undefined ? {} : { stdin });
  return {
    onPeer: (alias, command, stdin) => run(peerSsh(alias, command), { ...input(stdin), timeoutMs: shellLimitMs }),
    toHub: async (args) => (await run(peerSsh(hub, remoteFleet(args.map(quote).join(" "))), { timeoutMs: hubCallLimitMs, inherit: true })).code,
    run: (argv, stdin) => run(argv, { ...input(stdin), timeoutMs: shellLimitMs }),
  };
}

export function peerMachine(env: Env = Bun.env, home = homedir(), self = hostname(), label = "Fleet box"): PeerMachine {
  const devboxes = [...new Set([...readProfile(env).devboxes, ...savedDevboxes(home)])];
  const hub = stringSetting("hub.alias", env);
  const ownNames = namesOfThisMachine(home, hub);
  const { onPeer, run } = shellsWith(capture, hub);
  return {
    home,
    self,
    peers: peersOf(hub, devboxes, self).filter((alias) => !ownNames.includes(alias) && !isBoxName(alias)),
    devboxes,
    onPeer,
    run,
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    freePort,
    environmentId,
    linkEnvironment: async (input) => void (await withT3Session((client) => client.call("peerLinks.link", input), { home, scopes: ["access:read", "access:write"] })),
    print: (line) => console.log(line),
    say: (line) => console.error(`${label}: ${line}`),
  };
}

export function thisMachine(env: Env = Bun.env, home = homedir()): Machine {
  const settings = readBoxSettings(env);
  const here = peerMachine(env, home);
  const plan = readProfile(env).plan;
  const { toHub } = shellsWith(capture, settings.alias);
  return { ...here, workspace: env.CODER_WORKSPACE_NAME ?? here.self, isHub: readRole(home) === "hub", codex: plan === "codex" || plan === "both", settings, toHub };
}
