import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { fleetMachine, runFleet } from "../../orchestration/lib/testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

async function hubProfile() {
  const home = temp.make("fleet-hub-cli-");
  const profile = await fleetMachine(home, { "hub.alias": "my-hub", "hub.coderUrl": "https://coder.example.com", "hub.boxTemplate": "linux-box" });
  const fleet = JSON.parse(readFileSync(join(profile, "fleet.json"), "utf8"));
  const team = join(home, ".local/share/fleet/sources/team");
  mkdirSync(join(team, ".git"), { recursive: true });
  mkdirSync(join(team, "packs/posthog"), { recursive: true });
  writeFileSync(join(team, "packs/posthog/pack.json"), JSON.stringify({ schema: 1, name: "posthog", summary: "A team pack that brings Coder." }));
  const sources = [...fleet.sources, { name: "team", repo: "example/team-packs", ref: "main" }];
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ ...fleet, sources, packs: ["hub", "posthog"], devboxes: ["devbox-2"] }));
  return home;
}

test("through fleet, sweep refuses on a machine that is not the hub, and fleet hub here makes it the hub", async () => {
  const home = await hubProfile();
  const refused = await runFleet(["box", "sweep"], { HOME: home });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("fleet box sweep runs only on the hub. This machine's role is linux. Run fleet hub here on the hub");
  expect((await runFleet(["hub", "here"], { HOME: home })).code).toBe(0);
  const status = await runFleet(["hub", "status"], { HOME: home });
  expect(status).toEqual({ stdout: "This machine's role: hub\nhub.alias: my-hub\n", stderr: "", code: 0 });
});
