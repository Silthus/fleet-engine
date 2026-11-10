import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { balance, balanceCommand, priorities, quotaStatus, type Credential } from "./cli-proxy-balance.ts";
import { roleHome } from "./run-testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const now = Date.parse("2026-11-05T12:00:00Z");
const day = 86_400_000;
const managementKey = "e3".repeat(32);
const credential = (name: string, fields: Partial<Credential> = {}): Credential => ({ name, authIndex: name, provider: "claude", priority: 0, quotaCooldown: false, blocked: false, ...fields });
const weekly = (utilization: number, resetsInDays: number) => ({ sevenDay: { utilization, resetsAt: now + resetsInDays * day }, scoped: [] });

test("the subscription whose weekly quota resets first gets the highest priority; a full or unreadable one gets 0", () => {
  const ranked = priorities([
    credential("late.json", { usage: weekly(10, 6) }),
    credential("soon.json", { usage: weekly(90, 1) }),
    credential("full.json", { usage: weekly(100, 2) }),
    credential("unread.json"),
    credential("mid.json", { usage: weekly(40, 3) }),
  ]);
  expect(Object.fromEntries(ranked)).toEqual({ "soon.json": 3, "mid.json": 2, "late.json": 1, "full.json": 0, "unread.json": 0 });
});

test("a full five-hour or model window makes a subscription exhausted, and a missing weekly window makes it unknown", () => {
  expect(quotaStatus(credential("a", { usage: { ...weekly(10, 1), fiveHour: { utilization: 100 } } }))).toBe("exhausted");
  expect(quotaStatus(credential("a", { usage: { ...weekly(10, 1), scoped: [{ utilization: 100 }] } }))).toBe("exhausted");
  expect(quotaStatus(credential("a", { usage: { scoped: [] } }))).toBe("unknown");
  expect(quotaStatus(credential("a", { usage: weekly(-1, 1) }))).toBe("unknown");
  expect(quotaStatus(credential("a", { usage: weekly(99, 1) }))).toBe("available");
});

test("a Codex subscription needs only one readable window, and any full window makes it exhausted", () => {
  const codex = (usage: Credential["usage"]) => quotaStatus(credential("x", { provider: "codex", usage }));
  expect(codex({ fiveHour: { utilization: 30 }, scoped: [] })).toBe("available");
  expect(codex({ sevenDay: { utilization: 30 }, scoped: [] })).toBe("available");
  expect(codex({ fiveHour: { utilization: 30 }, scoped: [{ utilization: 100 }] })).toBe("exhausted");
  expect(codex({ scoped: [] })).toBe("unknown");
});

type Call = { method: string; path: string; body?: unknown; auth: string };

const codexUsageUrl = "https://chatgpt.com/backend-api/wham/usage";
const seconds = (days: number) => Math.round((now + days * day) / 1000);
const codexLimit = (fiveHour: number, weeklyUsed: number, fields: Record<string, unknown> = {}) => ({
  allowed: true, limit_reached: false,
  primary_window: { used_percent: fiveHour, limit_window_seconds: 18_000, reset_at: seconds(0.1) },
  secondary_window: { used_percent: weeklyUsed, limit_window_seconds: 604_800, reset_at: seconds(3) },
  ...fields,
});

function managementApi(state: { strategy?: string; usage?: Record<string, unknown>; codexUsage?: Record<string, unknown>; files?: unknown[] } = {}) {
  const calls: Call[] = [];
  const iso = (days: number) => new Date(now + days * day).toISOString();
  const usage: Record<string, unknown> = state.usage ?? {
    "1": { seven_day: { utilization: 20, resets_at: iso(5) }, five_hour: { utilization: 5, resets_at: iso(0.1) } },
    "2": { seven_day: { utilization: 70, resets_at: iso(1) }, seven_day_opus: { utilization: 30, resets_at: iso(1) } },
    "3": { seven_day: { utilization: 100, resets_at: iso(2) } },
  };
  const codexUsage: Record<string, unknown> = state.codexUsage ?? { "5": { rate_limit: codexLimit(30, 10) } };
  const files = state.files ?? [
    { name: "a.json", provider: "claude", auth_index: "1", priority: 2 },
    { name: "b.json", provider: "claude", auth_index: "2", priority: 1, unavailable: true, cooldowns: [{ reason: "quota" }] },
    { name: "c.json", provider: "claude", auth_index: "3", priority: 0 },
    { name: "off.json", provider: "claude", auth_index: "4", disabled: true },
    { name: "codex.json", provider: "codex", auth_index: "5", priority: 7 },
  ];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname.replace("/v0/management/", ""), ...(body === undefined ? {} : { body }), auth: new Headers(init?.headers).get("authorization") ?? "" });
    if (url.origin !== "http://127.0.0.1:8317") throw new TypeError("refused");
    if (url.pathname.endsWith("routing/strategy")) return Response.json({ strategy: state.strategy ?? "round-robin" });
    if (url.pathname.endsWith("auth-files")) return Response.json({ files });
    if (url.pathname.endsWith("api-call")) {
      expect(body.header.Authorization).toBe("Bearer $TOKEN$");
      const found = body.url === codexUsageUrl ? codexUsage[body.auth_index] : body.url === "https://api.anthropic.com/api/oauth/usage" ? usage[body.auth_index] : undefined;
      return Response.json(found ? { status_code: 200, body: JSON.stringify(found) } : { status_code: 401, body: "" });
    }
    return Response.json({});
  };
  return { fetch, calls };
}

test("balance sets fill-first routing, ranks the Claude subscriptions by weekly reset, and clears a cooldown that live usage disproves", async () => {
  const { fetch, calls } = managementApi();
  const lines: string[] = [];
  await balance({ fetch, managementKey, now, dryRun: false, log: (line) => lines.push(line) });
  const writes = calls.filter((call) => call.method !== "GET" && call.path !== "api-call");
  expect(writes).toEqual([
    { method: "PUT", path: "routing/strategy", body: { value: "fill-first" }, auth: `Bearer ${managementKey}` },
    { method: "PATCH", path: "auth-files/fields", body: { name: "a.json", priority: 1 }, auth: `Bearer ${managementKey}` },
    { method: "PATCH", path: "auth-files/fields", body: { name: "b.json", priority: 2 }, auth: `Bearer ${managementKey}` },
    { method: "POST", path: "reset-quota", body: { auth_index: "2" }, auth: `Bearer ${managementKey}` },
  ]);
  expect(calls.some((call) => (call.body as { auth_index?: string } | undefined)?.auth_index === "4")).toBe(false);
  expect(lines).toContain("routing strategy round-robin -> fill-first");
  expect(lines).toContain("b.json: priority 1 -> 2, 7d 70% resets in 1d 0h, 5h unknown");
  expect(lines).toContain("a.json: priority 2 -> 1, 7d 20% resets in 5d 0h, 5h 5% resets in 2h");
  expect(lines).toContain("b.json: cleared quota cooldown after live usage confirmed capacity");
});

test("a dry run reads usage and logs the ranking, but writes nothing", async () => {
  const { fetch, calls } = managementApi();
  const lines: string[] = [];
  await balance({ fetch, managementKey, now, dryRun: true, log: (line) => lines.push(line) });
  expect(calls.filter((call) => call.method !== "GET" && call.path !== "api-call")).toEqual([]);
  expect(lines).toContain("c.json: priority 0, 7d 100% resets in 2d 0h, 5h unknown");
});

test("a balanced pool with fill-first routing changes nothing and logs nothing", async () => {
  const files = [{ name: "a.json", provider: "claude", auth_index: "1", priority: 1 }, { name: "b.json", provider: "claude", auth_index: "2", priority: 2 }];
  const { fetch, calls } = managementApi({ strategy: "fill-first", files });
  const lines: string[] = [];
  await balance({ fetch, managementKey, now, dryRun: false, log: (line) => lines.push(line) });
  expect(calls.filter((call) => call.method !== "GET" && call.path !== "api-call")).toEqual([]);
  expect(lines).toEqual([]);
});

test("fleet cli-proxy-balance runs only on the hub, reads the management key from its private file, and refuses unknown options", async () => {
  const { fetch, calls } = managementApi({ strategy: "fill-first" });
  const lines: string[] = [];
  const deps = (home: string) => ({ home, fetch, now: () => now, log: (line: string) => lines.push(line) });
  await expect(balanceCommand([], deps(roleHome(temp.make("fleet-balance-"), "devbox")))).rejects.toThrow("fleet cli-proxy-balance runs only on the hub");
  const home = roleHome(temp.make("fleet-balance-"), "hub");
  await expect(balanceCommand([], deps(home))).rejects.toThrow("Run fleet cli-proxy install");
  mkdirSync(join(home, ".local/share/fleet-cli-proxy"), { recursive: true });
  writeFileSync(join(home, ".local/share/fleet-cli-proxy/management.env"), `MANAGEMENT_PASSWORD=${managementKey}\n`);
  await expect(balanceCommand(["--fast"], deps(home))).rejects.toThrow("Usage: fleet cli-proxy-balance [--dry-run]");
  expect(await balanceCommand(["--dry-run"], deps(home))).toBe(0);
  expect(calls.every((call) => call.auth === `Bearer ${managementKey}`)).toBe(true);
  expect(lines.join("\n")).not.toContain(managementKey);
});

test("balance reads each Codex subscription's windows from its own usage API, logs them, and leaves Codex priorities alone", async () => {
  const { fetch, calls } = managementApi();
  const lines: string[] = [];
  await balance({ fetch, managementKey, now, dryRun: true, log: (line) => lines.push(line) });
  expect(calls).toContainEqual(expect.objectContaining({ path: "api-call", body: { auth_index: "5", method: "GET", url: codexUsageUrl, header: { Authorization: "Bearer $TOKEN$" } } }));
  expect(lines).toContain("codex.json: priority 7, 7d 10% resets in 3d 0h, 5h 30% resets in 2h");

  const live = managementApi();
  await balance({ fetch: live.fetch, managementKey, now, dryRun: false, log: () => {} });
  expect(live.calls.filter((call) => call.path === "auth-files/fields").map((call) => (call.body as { name: string }).name)).not.toContain("codex.json");
});

test("a Codex subscription that hit its limit stays in its cooldown, and one whose live usage shows capacity has its cooldown cleared", async () => {
  const files = [
    { name: "spent.json", provider: "codex", auth_index: "5", priority: 0, unavailable: true, cooldowns: [{ reason: "quota" }] },
    { name: "free.json", provider: "codex", auth_index: "6", priority: 0, unavailable: true, cooldowns: [{ reason: "quota" }] },
  ];
  const codexUsage = { "5": { rate_limit: codexLimit(100, 40, { allowed: false, limit_reached: true }) }, "6": { rate_limit: codexLimit(20, 40) } };
  const { fetch, calls } = managementApi({ strategy: "fill-first", files, codexUsage });
  const lines: string[] = [];
  await balance({ fetch, managementKey, now, dryRun: false, log: (line) => lines.push(line) });
  expect(calls.filter((call) => call.path === "reset-quota").map((call) => call.body)).toEqual([{ auth_index: "6" }]);
  expect(lines).toContain("free.json: cleared quota cooldown after live usage confirmed capacity");
});

test("a Codex subscription whose limit is reached is exhausted even when its windows read below 100%", async () => {
  const files = [{ name: "capped.json", provider: "codex", auth_index: "5", priority: 0, unavailable: true, cooldowns: [{ reason: "quota" }] }];
  const codexUsage = { "5": { rate_limit: codexLimit(40, 40, { limit_reached: true }) } };
  const { fetch, calls } = managementApi({ strategy: "fill-first", files, codexUsage });
  await balance({ fetch, managementKey, now, dryRun: false, log: () => {} });
  expect(calls.filter((call) => call.path === "reset-quota")).toEqual([]);
});

test("unreadable Codex usage is logged as unreadable and clears no cooldown", async () => {
  const files = [{ name: "odd.json", provider: "codex", auth_index: "5", priority: 0, unavailable: true, cooldowns: [{ reason: "quota" }] }];
  const { fetch, calls } = managementApi({ strategy: "fill-first", files, codexUsage: { "5": { rate_limit: { allowed: true } } } });
  const lines: string[] = [];
  await balance({ fetch, managementKey, now, dryRun: false, log: (line) => lines.push(line) });
  expect(lines).toEqual(["odd.json: priority 0, usage unreadable"]);
  expect(calls.filter((call) => call.path === "reset-quota")).toEqual([]);
});

test("balance reports each blocked credential of either provider on every run, and a quota cooldown is not a block", async () => {
  const files = [
    { name: "a.json", provider: "claude", auth_index: "1", priority: 1 },
    { name: "revoked.json", provider: "claude", auth_index: "2", priority: 2, unavailable: true, status_message: JSON.stringify({ error: { type: "authentication_error", message: "token revoked" } }) },
    { name: "codex.json", provider: "codex", auth_index: "5", priority: 0, unavailable: true, cooldowns: [{ reason: "unauthorized" }] },
    { name: "waiting.json", provider: "codex", auth_index: "6", priority: 0, unavailable: true, cooldowns: [{ reason: "quota" }] },
  ];
  const codexUsage = { "5": { rate_limit: codexLimit(10, 10) }, "6": { rate_limit: codexLimit(100, 10, { limit_reached: true }) } };
  const { fetch } = managementApi({ strategy: "fill-first", files, codexUsage });
  const runs: string[][] = [[], []];
  for (const lines of runs) await balance({ fetch, managementKey, now, dryRun: false, log: (line) => lines.push(line) });
  for (const lines of runs) {
    expect(lines.filter((line) => line.includes("blocked"))).toEqual([
      "revoked.json: blocked (authentication_error). The proxy skips this Claude subscription until you sign it in again on the hub.",
      "codex.json: blocked (unauthorized). The proxy skips this Codex subscription until you sign it in again on the hub.",
    ]);
  }
  expect(runs[0]!.join("\n")).not.toContain("token revoked");
});
