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
const credential = (name: string, fields: Partial<Credential> = {}): Credential => ({ name, authIndex: name, priority: 0, quotaCooldown: false, ...fields });
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

type Call = { method: string; path: string; body?: unknown; auth: string };

function managementApi(state: { strategy?: string; usage?: Record<string, unknown>; files?: unknown[] } = {}) {
  const calls: Call[] = [];
  const iso = (days: number) => new Date(now + days * day).toISOString();
  const usage: Record<string, unknown> = state.usage ?? {
    "1": { seven_day: { utilization: 20, resets_at: iso(5) }, five_hour: { utilization: 5, resets_at: iso(0.1) } },
    "2": { seven_day: { utilization: 70, resets_at: iso(1) }, seven_day_opus: { utilization: 30, resets_at: iso(1) } },
    "3": { seven_day: { utilization: 100, resets_at: iso(2) } },
  };
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
      const found = usage[body.auth_index];
      expect(body.url).toBe("https://api.anthropic.com/api/oauth/usage");
      expect(body.header.Authorization).toBe("Bearer $TOKEN$");
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
  expect(calls.some((call) => ["4", "5"].includes((call.body as { auth_index?: string } | undefined)?.auth_index ?? ""))).toBe(false);
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
