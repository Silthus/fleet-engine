import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { fleetMachine, runFleet } from "../../orchestration/lib/testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

async function balancingDevbox() {
  const home = temp.make("fleet-cli-proxy-cli-");
  const profile = await fleetMachine(home, { "hub.alias": "my-hub" });
  const fleet = JSON.parse(readFileSync(join(profile, "fleet.json"), "utf8"));
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ ...fleet, packs: ["hub"], workflows: { "own-account-balancing": true } }));
  return home;
}

test("through fleet, the hub-only modes and the balancer refuse on a devbox, and the checks without a key fail and change nothing", async () => {
  const home = await balancingDevbox();
  const install = await runFleet(["cli-proxy", "install"], { HOME: home });
  expect([install.code, install.stderr]).toEqual([1, "fleet cli-proxy: fleet cli-proxy install runs only on the hub. This machine's role is linux. Run fleet hub here on the hub, or run this there.\n"]);
  const balance = await runFleet(["cli-proxy-balance"], { HOME: home });
  expect([balance.code, balance.stderr]).toEqual([1, "fleet cli-proxy-balance: fleet cli-proxy-balance runs only on the hub. This machine's role is linux. Run fleet hub here on the hub, or run this there.\n"]);
  const usage = await runFleet(["cli-proxy", "connect", "extra"], { HOME: home });
  expect(usage.code).toBe(2);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: 'cat "$HOME/.config/fleet/cli-proxy.key"' }));
  const check = await runFleet(["cli-proxy", "check"], { HOME: home });
  expect(check.code).toBe(1);
  expect(check.stdout).toContain("fleet apply keeps Claude Code on its own sign-in until the proxy serves it.");
  expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).apiKeyHelper).toBe('cat "$HOME/.config/fleet/cli-proxy.key"');
  const codex = await runFleet(["cli-proxy", "check", "codex"], { HOME: home });
  expect([codex.code, codex.stdout]).toEqual([1, expect.stringContaining("fleet apply keeps Codex on its own sign-in until the proxy serves it.")]);
  for (const args of [["check", "claude"], ["route"]]) expect((await runFleet(["cli-proxy", ...args], { HOME: home })).code).toBe(2);
});
