import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { numberSetting, optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import { capture, type Env, type Result } from "./coder.ts";
import type { Clock } from "./pool.ts";

export type BoxSettings = {
  alias: string; coderUrl: string; template: string; diskGigabytes: number; poolSize: number;
  idleHours: number; reapDays: number; keepDirs: string[]; relayPort: number; warmCommand?: string;
};

export type Machine = Clock & {
  home: string;
  self: string;
  workspace: string;
  isHub: boolean;
  peers: string[];
  devboxes: string[];
  codex: boolean;
  settings: BoxSettings;
  onPeer(alias: string, command: string, stdin?: string): Result;
  run(argv: string[], stdin?: string): Result;
  freePort(): number;
  environmentId(url: string, timeoutMs: number): Promise<string | undefined>;
  print(line: string): void;
  say(line: string): void;
};

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
export const remoteFleet = (args: string) => `sh "$HOME/.local/share/fleet/engine/fleet" ${args}`;
const machinePath = (home: string) => join(home, ".config/fleet/machine.json");

export function readBoxSettings(env: Env): BoxSettings {
  const warmCommand = optionalStringSetting("hub.boxWarmCommand", env);
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
  const partial = `${machinePath(home)}.${process.pid}.partial`;
  await writeFile(partial, JSON.stringify({ ...machine, role: "hub" }, null, 2) + "\n");
  await rename(partial, machinePath(home));
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

export function devboxesOf(env: Env, home: string): string[] {
  return [...new Set([...readProfile(env).devboxes, ...savedDevboxes(home)])];
}

export function thisMachine(env: Env = Bun.env, home = homedir()): Machine {
  const settings = readBoxSettings(env);
  const profile = readProfile(env);
  const devboxes = devboxesOf(env, home);
  const self = hostname();
  return {
    home,
    self,
    workspace: env.CODER_WORKSPACE_NAME ?? self,
    isHub: readRole(home) === "hub",
    peers: peersOf(settings.alias, devboxes, self),
    devboxes,
    codex: profile.plan === "codex" || profile.plan === "both",
    settings,
    onPeer: (alias, command, stdin) => capture(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias, `bash -lc ${quote(command)}`], stdin === undefined ? {} : { stdin }),
    run: (argv, stdin) => capture(argv, stdin === undefined ? {} : { stdin }),
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    freePort,
    environmentId,
    print: (line) => console.log(line),
    say: (line) => console.error(`Fleet box: ${line}`),
  };
}
