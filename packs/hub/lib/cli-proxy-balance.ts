import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireHubRole } from "./hub-job.ts";
import type { Fetch } from "./mcphub/client.ts";

export type UsageWindow = { utilization: number; resetsAt?: number };
export type Usage = { fiveHour?: UsageWindow; sevenDay?: UsageWindow; scoped: UsageWindow[] };
export type Credential = { name: string; authIndex: string; priority: number; usage?: Usage; quotaCooldown: boolean };
export type Balance = { fetch: Fetch; managementKey: string; now: number; dryRun: boolean; log(line: string): void };
export type BalanceDeps = { home: string; fetch: Fetch; now(): number; log(line: string): void };

type AuthFile = { name: string; provider?: string; disabled?: boolean; priority?: number; auth_index?: string; unavailable?: boolean; status_message?: string; cooldowns?: { reason?: string }[] };
type RawWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined;

export const proxyUrl = "http://127.0.0.1:8317";
export const proxyDir = (home: string) => join(home, ".local/share/fleet-cli-proxy");
export const managementFile = (home: string) => join(proxyDir(home), "management.env");
export const managementPattern = /^MANAGEMENT_PASSWORD=([0-9a-f]{64})\n$/;
const usageUrl = "https://api.anthropic.com/api/oauth/usage";
const strategy = "fill-first";
const hour = 3_600_000;

export async function management(fetch: Fetch, key: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${proxyUrl}/v0/management/${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`The CLI proxy management API ${path} returned ${response.status}.`);
  return response.json();
}

export function quotaStatus({ usage }: Credential): "available" | "exhausted" | "unknown" {
  if (!usage?.sevenDay) return "unknown";
  const windows = [usage.fiveHour, usage.sevenDay, ...usage.scoped].filter((window) => window !== undefined);
  if (!windows.every((window) => Number.isFinite(window.utilization) && window.utilization >= 0)) return "unknown";
  return windows.some((window) => window.utilization >= 100) ? "exhausted" : "available";
}

const hasCapacity = (credential: Credential) => quotaStatus(credential) === "available";
const weeklyReset = ({ usage }: Credential) => usage?.sevenDay?.resetsAt ?? Number.POSITIVE_INFINITY;

export function priorities(credentials: Credential[]): Map<string, number> {
  const ladder = credentials.filter(hasCapacity).sort((a, b) => weeklyReset(a) - weeklyReset(b) || a.name.localeCompare(b.name));
  return new Map(credentials.map((credential) => {
    const rank = ladder.indexOf(credential);
    return [credential.name, rank === -1 ? 0 : ladder.length - rank];
  }));
}

export async function balance(options: Balance): Promise<void> {
  const call = (path: string, init?: RequestInit) => management(options.fetch, options.managementKey, path, init);
  const current = ((await call("routing/strategy")) as { strategy?: string }).strategy;
  if (current !== strategy) {
    options.log(`routing strategy ${current || "unset"} -> ${strategy}`);
    if (!options.dryRun) await call("routing/strategy", { method: "PUT", body: JSON.stringify({ value: strategy }) });
  }
  const { files } = (await call("auth-files")) as { files: AuthFile[] };
  const enabled = files.filter((file) => file.provider === "claude" && !file.disabled && file.auth_index);
  const credentials = await Promise.all(enabled.map(async (file): Promise<Credential> => ({
    name: file.name, authIndex: file.auth_index!, priority: file.priority ?? 0, quotaCooldown: quotaCooldown(file), usage: await readUsage(call, file.auth_index!),
  })));
  if (!credentials.length) options.log("The proxy holds no enabled Claude subscription.");
  const planned = priorities(credentials);
  const changed = credentials.filter((credential) => planned.get(credential.name) !== credential.priority);
  if (options.dryRun || changed.length || credentials.some((credential) => !credential.usage)) {
    for (const credential of credentials) options.log(describe(credential, planned.get(credential.name)!, options.now));
  }
  if (options.dryRun) return;
  for (const credential of changed) await call("auth-files/fields", { method: "PATCH", body: JSON.stringify({ name: credential.name, priority: planned.get(credential.name) }) });
  for (const credential of credentials.filter((item) => item.quotaCooldown && hasCapacity(item))) {
    await call("reset-quota", { method: "POST", body: JSON.stringify({ auth_index: credential.authIndex }) });
    options.log(`${credential.name}: cleared quota cooldown after live usage confirmed capacity`);
  }
}

function quotaCooldown(file: AuthFile): boolean {
  if (!file.unavailable) return false;
  if (file.cooldowns?.length) return file.cooldowns.every(({ reason }) => reason === "quota" || reason === "credential_quota");
  try { return JSON.parse(file.status_message ?? "").error?.type === "rate_limit_error"; }
  catch { return false; }
}

async function readUsage(call: (path: string, init?: RequestInit) => Promise<unknown>, authIndex: string): Promise<Usage | undefined> {
  try {
    const header = { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" };
    const response = (await call("api-call", { method: "POST", body: JSON.stringify({ auth_index: authIndex, method: "GET", url: usageUrl, header }) })) as { status_code: number; body: string };
    if (response.status_code !== 200) return undefined;
    const usage = JSON.parse(response.body) as Record<string, RawWindow>;
    const scoped: UsageWindow[] = [];
    for (const [key, raw] of Object.entries(usage)) {
      if (!key.startsWith("seven_day_") || key === "seven_day_breakdown" || raw == null) continue;
      const window = usageWindow(raw);
      if (!window) return undefined;
      scoped.push(window);
    }
    return { fiveHour: usageWindow(usage.five_hour), sevenDay: usageWindow(usage.seven_day), scoped };
  } catch { return undefined; }
}

function usageWindow(raw: RawWindow): UsageWindow | undefined {
  if (typeof raw?.utilization !== "number" || !Number.isFinite(raw.utilization) || raw.utilization < 0) return undefined;
  const resetsAt = Date.parse(raw.resets_at ?? "");
  return { utilization: raw.utilization, ...(Number.isNaN(resetsAt) ? {} : { resetsAt }) };
}

function describe(credential: Credential, priority: number, now: number): string {
  const change = credential.priority === priority ? `priority ${priority}` : `priority ${credential.priority} -> ${priority}`;
  if (!credential.usage) return `${credential.name}: ${change}, usage unreadable`;
  const window = (label: string, value?: UsageWindow) => (value ? `${label} ${value.utilization}% resets in ${value.resetsAt === undefined ? "unknown" : duration(value.resetsAt - now)}` : `${label} unknown`);
  return `${credential.name}: ${change}, ${window("7d", credential.usage.sevenDay)}, ${window("5h", credential.usage.fiveHour)}`;
}

function duration(milliseconds: number): string {
  const hours = Math.max(0, Math.round(milliseconds / hour));
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`;
}

export async function readManagementKey(home: string): Promise<string> {
  const text = await readFile(managementFile(home), "utf8").catch(() => "");
  const key = managementPattern.exec(text)?.[1];
  if (!key) throw new Error(`${managementFile(home)} holds no management key. Run fleet cli-proxy install.`);
  return key;
}

export async function balanceCommand(args: string[], deps: BalanceDeps): Promise<number> {
  requireHubRole(deps.home, "cli-proxy-balance");
  const managementKey = await readManagementKey(deps.home);
  if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: fleet cli-proxy-balance [--dry-run]");
  await balance({ fetch: deps.fetch, managementKey, now: deps.now(), dryRun: args.includes("--dry-run"), log: deps.log });
  return 0;
}
