import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableSource } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../src/testing/packs.ts";
import { providersCommand } from "./lib/availability.ts";
import { fakeProxy, modelRows, recoveryHome } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const start = Date.parse("2026-11-10T20:00:00Z");
const minute = 60_000;
const reportPath = (home: string) => join(home, ".local/state/fleet/provider-availability.json");

function providers(home: string, proxy: ReturnType<typeof fakeProxy>, now = start, args: string[] = []) {
  const lines: string[] = [];
  const exit = providersCommand(args, { home, env: { FLEET_MODELS: JSON.stringify(modelRows) }, fetch: proxy.fetch, now: () => now, print: (line) => lines.push(line) });
  return exit.then((code) => ({ code, lines }));
}

describe("the Recovery pack", () => {
  test("gives a machine fleet providers", () => {
    const plan = resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["hub", "recovery"] }, devbox);
    expect(plan.commands.providers).toMatchObject({ pack: "recovery" });
  });
});

describe("fleet providers", () => {
  test("probes each provider's model through the proxy and says which is available and which is exhausted", async () => {
    const home = recoveryHome(temp.make("home-"));
    const proxy = fakeProxy({ "claude-test-1": 200, "gpt-test-1": [429, "{}"] });
    const { code, lines } = await providers(home, proxy);
    expect(code).toBe(0);
    expect(lines).toEqual(["claude: available (checked 2026-11-10T20:00:00.000Z)", "codex: exhausted (checked 2026-11-10T20:00:00.000Z)"]);
    expect(proxy.calls).toEqual(["/v1/messages claude-test-1", "/v1/responses gpt-test-1"]);
    expect(JSON.parse(readFileSync(reportPath(home), "utf8"))).toEqual({
      checkedAt: "2026-11-10T20:00:00.000Z", providers: { claude: "available", codex: "exhausted" },
    });
    expect(statSync(reportPath(home)).mode & 0o777).toBe(0o600);
  });

  test("reads a proxy that names spent quota as exhausted, and any other failure as unknown", async () => {
    const home = recoveryHome(temp.make("home-"));
    const cooling = fakeProxy({ "claude-test-1": [503, "All credentials for model claude-test-1 are cooling down"], "gpt-test-1": [502, "bad gateway"] });
    expect((await providers(home, cooling)).lines.map((line) => line.split(" (")[0])).toEqual(["claude: exhausted", "codex: unknown"]);
    const silent = fakeProxy({});
    expect((await providers(home, silent, start + 10 * minute)).lines.map((line) => line.split(" (")[0])).toEqual(["claude: unknown", "codex: unknown"]);
  });

  test("says unknown without a call when the machine has no proxy route", async () => {
    const home = temp.make("home-");
    const proxy = fakeProxy({ "claude-test-1": 200, "gpt-test-1": 200 });
    expect((await providers(home, proxy)).lines.map((line) => line.split(" (")[0])).toEqual(["claude: unknown", "codex: unknown"]);
    expect(proxy.calls).toEqual([]);
  });

  test("says unknown without a call for a provider the model table does not use", async () => {
    const home = recoveryHome(temp.make("home-"));
    const proxy = fakeProxy({ "claude-test-1": 200 });
    const lines: string[] = [];
    await providersCommand([], { home, env: { FLEET_MODELS: JSON.stringify(modelRows.filter((row) => row.provider === "claude")) }, fetch: proxy.fetch, now: () => start, print: (line) => lines.push(line) });
    expect(lines.map((line) => line.split(" (")[0])).toEqual(["claude: available", "codex: unknown"]);
    expect(proxy.calls).toEqual(["/v1/messages claude-test-1"]);
  });

  test("reuses a report under five minutes old and probes again after that", async () => {
    const home = recoveryHome(temp.make("home-"));
    const first = fakeProxy({ "claude-test-1": 429, "gpt-test-1": 200 });
    await providers(home, first);
    const second = fakeProxy({ "claude-test-1": 200, "gpt-test-1": 200 });
    const reused = await providers(home, second, start + 5 * minute - 1);
    expect(reused.lines[0]).toBe("claude: exhausted (checked 2026-11-10T20:00:00.000Z)");
    expect(second.calls).toEqual([]);
    const fresh = await providers(home, second, start + 5 * minute);
    expect(fresh.lines[0]).toBe("claude: available (checked 2026-11-10T20:05:00.000Z)");
    expect(second.calls.length).toBe(2);
  });

  test("probes again when the saved report is unreadable or from the future", async () => {
    const home = recoveryHome(temp.make("home-"));
    mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
    const proxy = fakeProxy({ "claude-test-1": 200, "gpt-test-1": 200 });
    writeFileSync(reportPath(home), "not json");
    await providers(home, proxy);
    writeFileSync(reportPath(home), JSON.stringify({ checkedAt: new Date(start + minute).toISOString(), providers: { claude: "exhausted", codex: "exhausted" } }));
    expect((await providers(home, proxy)).lines[0]).toBe("claude: available (checked 2026-11-10T20:00:00.000Z)");
    expect(proxy.calls.length).toBe(4);
  });

  test("prints the report as JSON for agents and scripts", async () => {
    const home = recoveryHome(temp.make("home-"));
    const { lines } = await providers(home, fakeProxy({ "claude-test-1": 200, "gpt-test-1": 429 }), start, ["--json"]);
    expect(JSON.parse(lines.join("\n"))).toEqual({ checkedAt: "2026-11-10T20:00:00.000Z", providers: { claude: "available", codex: "exhausted" } });
    expect((await providers(home, fakeProxy({}), start, ["--nope"])).code).toBe(2);
  });
});
