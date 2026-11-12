import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export type UsageProperties = Record<string, string | number | boolean>;
export type UsageLine = { event: string; properties: UsageProperties; timestamp: string };
type Env = Record<string, string | undefined>;

export const hostSetting = "base.usageHost";
export const projectKeySetting = "base.usageProjectKey";
export const distinctIdSetting = "base.usageDistinctId";

const stateDir = (home: string) => join(home, ".local/state/fleet");
export const spoolPath = (home: string) => join(stateDir(home), "usage.jsonl");
export const sendingPath = (home: string) => join(stateDir(home), "usage.sending.jsonl");
export const arrivingPath = (home: string) => `${sendingPath(home)}.new`;
const snapshotPath = (home: string) => join(stateDir(home), "settings.json");
export const spoolLimit = 5_000_000;
const plainName = /^[A-Za-z0-9._-]{1,64}$/;

/** off: the settings name no destination host, because the workflow is off. unknown: Fleet cannot read the settings. */
function usageState(home: string): "on" | "off" | "unknown" {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(snapshotPath(home), "utf8")) as Record<string, unknown>;
  } catch {
    return "unknown";
  }
  if (settings[hostSetting] === undefined) return "off";
  return [hostSetting, projectKeySetting].every((key) => typeof settings[key] === "string" && (settings[key] as string).trim() !== "") ? "on" : "unknown";
}

export const usageOn = (home: string) => usageState(home) === "on";

export function machineName(env: Env = Bun.env): string {
  const name = env.CODER_WORKSPACE_NAME || hostname().split(".")[0] || "";
  return plainName.test(name) ? name : "unknown";
}

export function callerOf(env: Env = Bun.env, interactive = Boolean(process.stdin.isTTY)): "agent" | "person" | "job" {
  if (env.CLAUDECODE || env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.T3CODE_THREAD_ID) return "agent";
  return interactive ? "person" : "job";
}

export function track(home: string, event: string, properties: UsageProperties = {}, env: Env = Bun.env, interactive?: boolean): void {
  try {
    const state = usageState(home);
    if (state === "off") for (const file of [spoolPath(home), sendingPath(home), arrivingPath(home)]) rmSync(file, { force: true });
    if (state !== "on") return;
    const path = spoolPath(home);
    if ([path, sendingPath(home)].reduce((total, file) => total + (statSync(file, { throwIfNoEntry: false })?.size ?? 0), 0) > spoolLimit) return;
    mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
    const line: UsageLine = { event, properties: { ...properties, machine: machineName(env), caller: callerOf(env, interactive) }, timestamp: new Date().toISOString() };
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    return;
  }
}

/** Set on a fleet call that Fleet forwards to the hub, so the hub does not count the command a second time. */
export const forwardedMark = "FLEET_FORWARDED";

/** subcommands: the command's own first words. Any other first argument, such as a host, stays on the machine. */
export function trackCommand(home: string, command: string, args: string[], subcommands: readonly string[], env: Env = Bun.env, interactive?: boolean): void {
  if (env.FLEET_PROFILE_DIR || env[forwardedMark]) return;
  const first = args[0] ?? "";
  track(home, "fleet command", { command, subcommand: subcommands.includes(first) ? first : "" }, env, interactive);
}
