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
      const account = body.header["Chatgpt-Account-Id"];
      const found = body.url === codexUsageUrl ? codexUsage[account ? `${body.auth_index}@${account}` : body.auth_index] : body.url === "https://api.anthropic.com/api/oauth/usage" ? usage[body.auth_index] : undefined;
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
  expect(lines).toContain("Claude subscription 2: priority 1 -> 2, 7d 70% resets in 1d 0h, 5h unknown");
  expect(lines).toContain("Claude subscription 1: priority 2 -> 1, 7d 20% resets in 5d 0h, 5h 5% resets in 2h");
  expect(lines).toContain("Claude subscription 2: cleared quota cooldown after live usage confirmed capacity");
});

test("a dry run reads usage and logs the ranking, but writes nothing", async () => {
  const { fetch, calls } = managementApi();
  const lines: string[] = [];
  await balance({ fetch, managementKey, now, dryRun: true, log: (line) => lines.push(line) });
  expect(calls.filter((call) => call.method !== "GET" && call.path !== "api-call")).toEqual([]);
  expect(lines).toContain("Claude subscription 3: priority 0, 7d 100% resets in 2d 0h, 5h unknown");
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
  const deps = (home: string) => ({ home, fetch, now: () => now, ledger: false, log: (line: string) => lines.push(line) });
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
  expect(lines).toContain("Codex subscription 5: priority 7, 7d 10% resets in 3d 0h, 5h 30% resets in 2h");

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
  expect(lines).toContain("Codex subscription 6: cleared quota cooldown after live usage confirmed capacity");
});

test("from the raw usage answer, a Codex cooldown clears only while every limit has room and every window reads", async () => {
  const weeklyOnly = { allowed: true, limit_reached: false, primary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_at: seconds(3) }, secondary_window: null };
  const cases: Array<[string, unknown, boolean]> = [
    ["weekly only", { rate_limit: weeklyOnly }, true],
    ["main limit reached below 100%", { rate_limit: codexLimit(40, 40, { limit_reached: true }) }, false],
    ["main limit not allowed", { rate_limit: codexLimit(40, 40, { allowed: false }) }, false],
    ["extra limit full", { rate_limit: codexLimit(10, 10), additional_rate_limits: [{ rate_limit: codexLimit(100, 10) }] }, false],
    ["extra limit reached", { rate_limit: codexLimit(10, 10), additional_rate_limits: [{ rate_limit: codexLimit(10, 10, { limit_reached: true }) }] }, false],
    ["extra window malformed", { rate_limit: codexLimit(10, 10), additional_rate_limits: [{ rate_limit: codexLimit(10, 10, { secondary_window: { used_percent: "ten" } }) }] }, false],
    ["no windows", { rate_limit: { allowed: true, limit_reached: false } }, false],
  ];
  for (const [label, answer, clears] of cases) {
    const files = [{ name: "c.json", provider: "codex", auth_index: "5", priority: 0, unavailable: true, cooldowns: [{ reason: "quota" }] }];
    const { fetch, calls } = managementApi({ strategy: "fill-first", files, codexUsage: { "5": answer } });
    await balance({ fetch, managementKey, now, dryRun: false, log: () => {} });
    expect([label, calls.some((call) => call.path === "reset-quota")]).toEqual([label, clears]);
  }
});

test("the Codex usage call names the subscription's ChatGPT account, so a login with several accounts reads its own", async () => {
  const files = [
    { name: "work.json", provider: "codex", auth_index: "5", priority: 0, unavailable: true, cooldowns: [{ reason: "quota" }], id_token: { chatgpt_account_id: "acct-work" } },
    { name: "odd.json", provider: "codex", auth_index: "6", priority: 0, id_token: { chatgpt_account_id: "bad\r\nX-Injected: 1" } },
  ];
  const codexUsage = { "5": { rate_limit: codexLimit(100, 100, { limit_reached: true }) }, "5@acct-work": { rate_limit: codexLimit(10, 10) }, "6": { rate_limit: codexLimit(10, 10) } };
  const { fetch, calls } = managementApi({ strategy: "fill-first", files, codexUsage });
  await balance({ fetch, managementKey, now, dryRun: false, log: () => {} });
  const headers = calls.filter((call) => call.path === "api-call").map((call) => (call.body as { header: Record<string, string> }).header);
  expect(headers).toEqual([{ Authorization: "Bearer $TOKEN$", "Chatgpt-Account-Id": "acct-work" }, { Authorization: "Bearer $TOKEN$" }]);
  expect(calls.filter((call) => call.path === "reset-quota").map((call) => call.body)).toEqual([{ auth_index: "5" }]);
});

test("unreadable Codex usage is logged as unreadable and clears no cooldown", async () => {
  const files = [{ name: "odd.json", provider: "codex", auth_index: "5", priority: 0, unavailable: true, cooldowns: [{ reason: "quota" }] }];
  const { fetch, calls } = managementApi({ strategy: "fill-first", files, codexUsage: { "5": { rate_limit: { allowed: true } } } });
  const lines: string[] = [];
  await balance({ fetch, managementKey, now, dryRun: false, log: (line) => lines.push(line) });
  expect(lines).toEqual(["Codex subscription 5: priority 0, usage unreadable"]);
  expect(calls.filter((call) => call.path === "reset-quota")).toEqual([]);
});

test("balance tells an expired login apart from usage it could not read, ranks the rest, and exits 0, without printing the proxy's message", async () => {
  const files = [
    { name: "a.json", provider: "claude", auth_index: "1", priority: 1 },
    { name: "expired.json", provider: "claude", auth_index: "2", priority: 0, status: "error", status_message: '{"error":"invalid_grant","error_description":"refresh token for alice expired"}' },
    { name: "odd.json", provider: "claude", auth_index: "3", priority: 0, status: "error", status_message: "upstream hiccup for alice" },
    { name: "back.json", provider: "claude", auth_index: "4", priority: 0, status: "active", status_message: '{"error":"invalid_grant"}' },
  ];
  const { fetch } = managementApi({ strategy: "fill-first", files, usage: { "1": { seven_day: { utilization: 20, resets_at: new Date(now + day).toISOString() } } } });
  const lines: string[] = [];
  const home = roleHome(temp.make("fleet-balance-"), "hub");
  mkdirSync(join(home, ".local/share/fleet-cli-proxy"), { recursive: true });
  writeFileSync(join(home, ".local/share/fleet-cli-proxy/management.env"), `MANAGEMENT_PASSWORD=${managementKey}\n`);
  expect(await balanceCommand([], { home, fetch, now: () => now, ledger: false, log: (line) => lines.push(line) })).toBe(0);
  expect(lines.filter((line) => !line.startsWith("Claude subscription 1:"))).toEqual([
    "Claude subscription 2: priority 0, usage unreadable: its login expired. Sign it in again on the hub; fleet cli-proxy doctor names the command",
    "Claude subscription 3: priority 0, usage unreadable",
    "Claude subscription 4: priority 0, usage unreadable",
  ]);
  expect(lines.join("\n")).not.toContain("alice");
});

test("balance reports each blocked credential of either provider on every run, and a quota cooldown is not a block", async () => {
  const files = [
    { name: "a.json", provider: "claude", auth_index: "1", priority: 1 },
    { name: "revoked.json", provider: "claude", auth_index: "2", priority: 2, unavailable: true, status_message: JSON.stringify({ error: { type: "authentication_error", message: "token revoked" } }) },
    { name: "codex.json", provider: "codex", auth_index: "5", priority: 0, unavailable: true, cooldowns: [{ reason: "unauthorized" }] },
    { name: "waiting.json", provider: "codex", auth_index: "6", priority: 0, unavailable: true, cooldowns: [{ reason: "quota" }] },
    { name: "flaky.json", provider: "codex", auth_index: "7", priority: 0, unavailable: true, cooldowns: [{ reason: "transient_error" }, { reason: "quota" }] },
    { name: "unpaid.json", provider: "claude", auth_index: "8", priority: 0, unavailable: true, cooldowns: [{ reason: "payment_required" }] },
    { name: "named.json", provider: "claude", auth_index: "9", priority: 0, unavailable: true, status_message: JSON.stringify({ error: { type: "token_for_alice_was_revoked" } }) },
  ];
  const codexUsage = { "5": { rate_limit: codexLimit(10, 10) }, "6": { rate_limit: codexLimit(100, 10, { limit_reached: true }) }, "7": { rate_limit: codexLimit(10, 10) } };
  const { fetch } = managementApi({ strategy: "fill-first", files, codexUsage });
  const runs: string[][] = [[], []];
  for (const lines of runs) await balance({ fetch, managementKey, now, dryRun: false, log: (line) => lines.push(line) });
  for (const lines of runs) {
    expect(lines.filter((line) => line.includes("blocked"))).toEqual([
      "Claude subscription 2: blocked (authentication_error). The proxy skips it until you sign it in again on the hub.",
      "Codex subscription 5: blocked (unauthorized). The proxy skips it until you sign it in again on the hub.",
      "Codex subscription 7: blocked (transient_error). The proxy skips it until the block clears.",
      "Claude subscription 8: blocked (payment_required). The proxy skips it until its plan's billing is fixed.",
      "Claude subscription 9: blocked (unavailable). The proxy skips it until the block clears.",
    ]);
  }
  expect(runs[0]!.join("\n")).not.toContain("token revoked");
  expect(runs[0]!.join("\n")).not.toContain("alice");
});

test("the balancer's journal lines name each subscription by its short id, as fleet cli-proxy doctor does, and never by its auth file, which holds the account's email", async () => {
  const files = [
    { name: "claude-user@example.com.json", provider: "claude", auth_index: "aaaabbbbcccc", priority: 2 },
    { name: "claude-other@example.com.json", provider: "claude", auth_index: "ddddeeeeffff", priority: 1, unavailable: true, cooldowns: [{ reason: "quota" }] },
    { name: "claude-third@example.com.json", provider: "claude", auth_index: "1111222233334444", priority: 0, unavailable: true, cooldowns: [{ reason: "unauthorized" }] },
    { name: "codex-user@example.com-team.json", provider: "codex", auth_index: "not an index!", priority: 0 },
  ];
  const iso = (days: number) => new Date(now + days * day).toISOString();
  const usage = { aaaabbbbcccc: { seven_day: { utilization: 20, resets_at: iso(5) } }, ddddeeeeffff: { seven_day: { utilization: 70, resets_at: iso(1) } } };
  const { fetch } = managementApi({ files, usage, codexUsage: {} });
  const lines: string[] = [];
  await balance({ fetch, managementKey, now, dryRun: false, ledger: true, log: (line) => lines.push(line) });
  const hashed = new Bun.CryptoHasher("sha256").update("codex-user@example.com-team.json").digest("hex").slice(0, 8);
  expect(lines).toEqual([
    "routing strategy round-robin -> fill-first",
    "Claude subscription aaaabbbb: priority 2 -> 1, 7d 20% resets in 5d 0h, 5h unknown",
    "Claude subscription ddddeeee: priority 1 -> 2, 7d 70% resets in 1d 0h, 5h unknown",
    "Claude subscription 11112222: priority 0, usage unreadable",
    `Codex subscription ${hashed}: priority 0, usage unreadable`,
    "Claude subscription 11112222: blocked (unauthorized). The proxy skips it until you sign it in again on the hub.",
    "Claude subscription ddddeeee: cleared quota cooldown after live usage confirmed capacity",
  ]);
  for (const leak of ["@", "example.com", "user", "other", "third", ".json"]) expect(lines.join("\n")).not.toContain(leak);
});

test("while the panel is on, each balance records every named window of each subscription in the quota ledger, and a dry run or an off panel records none", async () => {
  const on = managementApi({ strategy: "fill-first" });
  await balance({ fetch: on.fetch, managementKey, now, dryRun: false, ledger: true, log: () => {} });
  const at = (days: number) => now + days * day;
  expect(on.calls.filter((call) => call.path === "quota-ledger/samples")).toEqual([{ method: "POST", path: "quota-ledger/samples", auth: `Bearer ${managementKey}`, body: { samples: [
    { at: now, auth: "a.json", provider: "claude", window: "five-hour", remaining: 95, resets_at: at(0.1) },
    { at: now, auth: "a.json", provider: "claude", window: "seven-day", remaining: 80, resets_at: at(5) },
    { at: now, auth: "b.json", provider: "claude", window: "seven-day", remaining: 30, resets_at: at(1) },
    { at: now, auth: "b.json", provider: "claude", window: "seven-day-opus", remaining: 70, resets_at: at(1) },
    { at: now, auth: "c.json", provider: "claude", window: "seven-day", remaining: 0, resets_at: at(2) },
    { at: now, auth: "codex.json", provider: "codex", window: "five-hour", remaining: 70, resets_at: seconds(0.1) * 1000 },
    { at: now, auth: "codex.json", provider: "codex", window: "weekly", remaining: 90, resets_at: seconds(3) * 1000 },
  ] } }]);
  for (const options of [{ dryRun: true, ledger: true }, { dryRun: false, ledger: false }]) {
    const quiet = managementApi({ strategy: "fill-first" });
    await balance({ fetch: quiet.fetch, managementKey, now, log: () => {}, ...options });
    expect([options, quiet.calls.some((call) => call.path === "quota-ledger/samples")]).toEqual([options, false]);
  }
});

test("a ledger that refuses its samples is logged, and the balance still finishes", async () => {
  const { fetch, calls } = managementApi({ strategy: "fill-first" });
  const refusing = async (input: string | URL | Request, init?: RequestInit) => (String(input).endsWith("quota-ledger/samples") ? (await fetch(input, init), new Response("missing", { status: 404 })) : fetch(input, init));
  const lines: string[] = [];
  await balance({ fetch: refusing, managementKey, now, dryRun: false, ledger: true, log: (line) => lines.push(line) });
  expect(lines).toContain("quota history not recorded: The CLI proxy management API quota-ledger/samples returned 404.");
  expect(calls.filter((call) => call.path === "reset-quota").map((call) => call.body)).toEqual([{ auth_index: "2" }]);
});
