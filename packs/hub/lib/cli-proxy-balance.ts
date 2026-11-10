import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireHubRole } from "./hub-job.ts";
import type { Fetch } from "../../mcp-gateway/lib/client.ts";

export type UsageWindow = { utilization: number; resetsAt?: number };
export type Usage = { fiveHour?: UsageWindow; sevenDay?: UsageWindow; scoped: UsageWindow[] };
export type Provider = "claude" | "codex";
export type Credential = { name: string; authIndex: string; provider: Provider; priority: number; usage?: Usage; quotaCooldown: boolean; blocked: string | false };
export type Balance = { fetch: Fetch; managementKey: string; now: number; dryRun: boolean; log(line: string): void };
export type BalanceDeps = { home: string; fetch: Fetch; now(): number; log(line: string): void };

type AuthFile = { name: string; provider?: string; disabled?: boolean; priority?: number; auth_index?: string; unavailable?: boolean; status_message?: string; cooldowns?: { reason?: string }[]; id_token?: { chatgpt_account_id?: unknown } };
type RawWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type CodexWindow = { used_percent?: number; reset_at?: number; limit_window_seconds?: number } | null | undefined;
type CodexLimit = { allowed?: boolean; limit_reached?: boolean; primary_window?: CodexWindow; secondary_window?: CodexWindow } | undefined;
type Call = (path: string, init?: RequestInit) => Promise<unknown>;

export const proxyUrl = "http://127.0.0.1:8317";
export const proxyDir = (home: string) => join(home, ".local/share/fleet-cli-proxy");
export const managementFile = (home: string) => join(proxyDir(home), "management.env");
export const managementPattern = /^MANAGEMENT_PASSWORD=([0-9a-f]{64})\n$/;
const usageUrl = "https://api.anthropic.com/api/oauth/usage";
const codexUsageUrl = "https://chatgpt.com/backend-api/wham/usage";
const providerNames: Record<Provider, string> = { claude: "Claude", codex: "Codex" };
const signInBlocks = ["invalid_grant", "unauthorized", "authentication_error", "permission_error"];
const waitBlocks = ["transient_error", "transient_rate_limit", "cloudflare_challenge", "overloaded_error", "api_error", "model_not_supported", "not_found", "unknown"];
const knownBlocks = new Set([...signInBlocks, ...waitBlocks, "payment_required"]);
const accountPattern = /^[A-Za-z0-9_-]{1,128}$/;
const strategy = "fill-first";
const hour = 3_600_000;

export async function management(fetch: Fetch, key: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${proxyUrl}/v0/management/${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`The CLI proxy management API ${path} returned ${response.status}.`);
  return response.json();
}

export function quotaStatus({ usage, provider }: Credential): "available" | "exhausted" | "unknown" {
  const windows = usage ? [usage.fiveHour, usage.sevenDay, ...usage.scoped].filter((window) => window !== undefined) : [];
  if (provider === "claude" ? !usage?.sevenDay : !windows.length) return "unknown";
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
  const enabled = files.filter((file) => (file.provider === "claude" || file.provider === "codex") && !file.disabled && file.auth_index);
  const credentials = await Promise.all(enabled.map(async (file): Promise<Credential> => {
    const provider = file.provider as Provider;
    const usage = provider === "codex" ? await readCodexUsage(call, file.auth_index!, codexAccount(file)) : await readUsage(call, file.auth_index!);
    return { name: file.name, authIndex: file.auth_index!, provider, priority: file.priority ?? 0, quotaCooldown: quotaCooldown(file), blocked: blocked(file), usage };
  }));
  const claude = credentials.filter((credential) => credential.provider === "claude");
  if (!credentials.length) options.log("The proxy holds no enabled Claude or Codex subscription.");
  const planned = new Map([...credentials.map((credential) => [credential.name, credential.priority] as const), ...priorities(claude)]);
  const changed = claude.filter((credential) => planned.get(credential.name) !== credential.priority);
  if (options.dryRun || changed.length || credentials.some((credential) => !credential.usage)) {
    for (const credential of credentials) options.log(describe(credential, planned.get(credential.name)!, options.now));
  }
  for (const credential of credentials) {
    if (credential.blocked) options.log(`${credential.name}: blocked (${credential.blocked}). The proxy skips this ${providerNames[credential.provider]} subscription ${until(credential.blocked)}.`);
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
  return statusType(file) === "rate_limit_error";
}

function statusType(file: AuthFile): unknown {
  try { return JSON.parse(file.status_message ?? "").error?.type; }
  catch { return undefined; }
}

const knownBlock = (code: unknown) => (typeof code === "string" && knownBlocks.has(code) ? code : "unavailable");

function blocked(file: AuthFile): string | false {
  if (!file.unavailable || quotaCooldown(file)) return false;
  const reasons = (file.cooldowns ?? []).filter(({ reason }) => reason !== "quota" && reason !== "credential_quota").map(({ reason }) => knownBlock(reason));
  return reasons.length ? [...new Set(reasons)].join(", ") : knownBlock(statusType(file));
}

function until(codes: string): string {
  const list = codes.split(", ");
  if (list.some((code) => signInBlocks.includes(code))) return "until you sign it in again on the hub";
  if (list.includes("payment_required")) return "until its plan's billing is fixed";
  return "until the block clears";
}

function codexAccount(file: AuthFile): string | undefined {
  const account = file.id_token?.chatgpt_account_id;
  return typeof account === "string" && accountPattern.test(account) ? account : undefined;
}

async function readCodexUsage(call: Call, authIndex: string, account: string | undefined): Promise<Usage | undefined> {
  try {
    const header = { Authorization: "Bearer $TOKEN$", ...(account ? { "Chatgpt-Account-Id": account } : {}) };
    const response = (await call("api-call", { method: "POST", body: JSON.stringify({ auth_index: authIndex, method: "GET", url: codexUsageUrl, header }) })) as { status_code: number; body: string };
    if (response.status_code !== 200) return undefined;
    const raw = JSON.parse(response.body) as { rate_limit?: CodexLimit; additional_rate_limits?: { rate_limit?: CodexLimit }[] };
    const usage: Usage = { scoped: [] };
    for (const [index, limit] of [raw.rate_limit, ...(raw.additional_rate_limits ?? []).map((item) => item?.rate_limit)].entries()) {
      if (typeof limit?.allowed !== "boolean" || typeof limit.limit_reached !== "boolean" || !limit.primary_window) return undefined;
      for (const value of [limit.primary_window, limit.secondary_window]) {
        if (value == null) continue;
        const window = codexWindow(value);
        if (!window) return undefined;
        if (index === 0 && value.limit_window_seconds === 18_000 && !usage.fiveHour) usage.fiveHour = window;
        else if (index === 0 && value.limit_window_seconds === 604_800 && !usage.sevenDay) usage.sevenDay = window;
        else usage.scoped.push(window);
      }
      if (!limit.allowed || limit.limit_reached) usage.scoped.push({ utilization: 100 });
    }
    return usage;
  } catch { return undefined; }
}

function codexWindow(raw: NonNullable<CodexWindow>): UsageWindow | undefined {
  if (typeof raw.used_percent !== "number" || !Number.isFinite(raw.used_percent) || raw.used_percent < 0) return undefined;
  return { utilization: raw.used_percent, ...(typeof raw.reset_at === "number" && Number.isFinite(raw.reset_at) ? { resetsAt: raw.reset_at * 1000 } : {}) };
}

async function readUsage(call: Call, authIndex: string): Promise<Usage | undefined> {
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
