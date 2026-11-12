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

test("through fleet, the hub's proxy keeps its panel off until the Proxy panel workflow is on, and that workflow needs Own-account balancing", async () => {
  const home = await balancingDevbox();
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8")), role: "hub" }));
  const profilePath = join(home, "profile/fleet.json");
  const turn = (workflows: Record<string, boolean>) => writeFileSync(profilePath, JSON.stringify({ ...JSON.parse(readFileSync(profilePath, "utf8")), workflows }));
  const plan = async () => (await runFleet(["cli-proxy", "plan"], { HOME: home })).stdout;
  expect(await plan()).toContain("  Keep the management panel off. Turn on the Proxy panel workflow to serve it.\n");
  turn({ "own-account-balancing": true, "proxy-panel": true });
  expect(await plan()).toContain("  Serve the management panel 1.27.3-fleet.1 at http://127.0.0.1:8317/management.html, loopback only, with 35 days of quota history from the quota-ledger plugin 0.1.0.\n");
  turn({ "proxy-panel": true });
  expect(await plan()).not.toContain("Serve the management panel");
});

test("through fleet, plan and install on a hub without the proxy binary yet name the install instead of stopping at the missing file", async () => {
  const home = await balancingDevbox();
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8")), role: "hub" }));
  const plan = await runFleet(["cli-proxy", "plan"], { HOME: home });
  expect([plan.code, plan.stderr, plan.stdout]).toEqual([0, "", expect.stringContaining(`  Install CLIProxyAPI 8.0.46 at ${join(home, ".local/share/fleet-cli-proxy/cli-proxy-api")}.\n`)]);
});
