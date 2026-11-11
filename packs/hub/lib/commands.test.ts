import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { fleetMachine, runFleet } from "../../orchestration/lib/testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const answered = { "hub.alias": "my-hub", "hub.coderUrl": "https://coder.example.com", "hub.boxTemplate": "linux-box" };

async function hubProfile(workflows: Record<string, boolean> = { boxes: true }, settings: Record<string, string> = answered, packs = ["hub", "posthog"]) {
  const home = temp.make("fleet-hub-cli-");
  const profile = await fleetMachine(home, settings);
  const fleet = JSON.parse(readFileSync(join(profile, "fleet.json"), "utf8"));
  const team = join(home, ".local/share/fleet/sources/team");
  mkdirSync(join(team, ".git"), { recursive: true });
  mkdirSync(join(team, "packs/posthog"), { recursive: true });
  writeFileSync(join(team, "packs/posthog/pack.json"), JSON.stringify({ schema: 1, name: "posthog", summary: "A team pack that brings Coder." }));
  const sources = [...fleet.sources, { name: "team", repo: "example/team-packs", ref: "main" }];
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ ...fleet, sources, packs, workflows, devboxes: ["devbox-2"] }));
  return home;
}

test("through fleet, sweep refuses on a machine that is not the hub", async () => {
  const home = await hubProfile();
  const refused = await runFleet(["box", "sweep"], { HOME: home });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("fleet box sweep runs only on the hub. This machine's role is linux. Run fleet hub here on the hub");
});

test("through fleet, box says how to turn Boxes on to use or release boxes while the workflow is off", async () => {
  const home = await hubProfile({});
  const refused = await runFleet(["box", "release", "box-1", "--delete"], { HOME: home });
  expect(refused).toMatchObject({ code: 1, stderr: "fleet box: Boxes is off. To use boxes, or to release boxes that still run, turn it on with fleet packs --workflows boxes=on, then run fleet apply.\n" });
});

const notReady = "fleet box: Boxes is on, but not ready here. It needs a team pack that brings Coder, and its settings answered: fleet apply names each unanswered setting.\n";

test("through fleet, box says Boxes is not ready, not off, while the workflow is on and its box template is unanswered", async () => {
  const { "hub.boxTemplate": _, ...unanswered } = answered;
  const home = await hubProfile({ boxes: true }, unanswered);
  const refused = await runFleet(["box", "list"], { HOME: home });
  expect(refused).toMatchObject({ code: 1, stderr: notReady });
});

test("through fleet, box says Boxes needs a pack that brings Coder while the workflow is on and no pack brings it", async () => {
  const home = await hubProfile({ boxes: true }, answered, ["hub"]);
  const refused = await runFleet(["box", "list"], { HOME: home });
  expect(refused).toMatchObject({ code: 1, stderr: notReady });
});

test("through fleet, dream refuses without the Memory pack, and dream digest prints this machine's sessions without their tokens", async () => {
  const home = await hubProfile();
  const refused = await runFleet(["dream", "budget"], { HOME: home });
  expect(refused).toMatchObject({ code: 1, stderr: "Dream needs the Memory pack: turn it on, then run fleet apply\n" });
  const token = `ghp_${"a1".repeat(18)}`;
  const project = join(home, ".claude/projects/-dev-app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "s-1.jsonl"), JSON.stringify({ type: "user", sessionId: "s-1", cwd: join(home, "dev/app"), timestamp: new Date().toISOString(), message: { role: "user", content: `Use this token: ${token}` } }));
  const digest = await runFleet(["dream", "digest", "--since", "1d"], { HOME: home, XDG_STATE_HOME: join(home, ".local/state") });
  expect(digest.code).toBe(0);
  expect(digest.stdout).toContain("[redacted GitHub token]");
  expect(digest.stdout).not.toContain(token);
  expect(JSON.parse(digest.stdout).repo).toBe("app");
});

test("through fleet, disk-watch refuses off the hub, and disk-sweep checks its arguments", async () => {
  const home = await hubProfile();
  const watch = await runFleet(["disk-watch"], { HOME: home });
  expect([watch.code, watch.stderr]).toEqual([1, "fleet disk-watch: fleet disk-watch runs only on the hub. This machine's role is linux. Run fleet hub here on the hub, or run this there.\n"]);
  const sweep = await runFleet(["disk-sweep", "--all"], { HOME: home });
  expect([sweep.code, sweep.stderr]).toEqual([1, "fleet disk-sweep: Usage: fleet disk-sweep [--dry-run] [--floor <gigabytes>] [--alert-floor <gigabytes>]\n"]);
});

test("through fleet, the hub pack's undo probe runs after the pack leaves the profile, for the step the ledger names, without its settings", async () => {
  const home = temp.make("fleet-hub-undo-");
  await fleetMachine(home, {});
  mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
  const step = { pack: "hub", id: "hub-https", check: ["fleet", "hub-https", "left"], undo: ["fleet", "hub-https", "remove"] };
  const peers = { pack: "hub", id: "peers", check: ["fleet", "peers", "left"], undo: ["fleet", "peers", "remove"] };
  writeFileSync(join(home, ".local/state/fleet/steps.json"), JSON.stringify({ version: 1, steps: [step, peers] }));
  expect((await runFleet(["hub-https", "left"], { HOME: home })).code).toBe(2);
  expect((await runFleet(["hub-https", "left"], { HOME: home, FLEET_UNDO: "hub/hub-https" })).code).toBe(1);
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  writeFileSync(join(home, ".config/systemd/user/fleet-hub-https.service"), "# Managed by Fleet hub HTTPS.\n[Unit]\n");
  expect((await runFleet(["hub-https", "left"], { HOME: home, FLEET_UNDO: "hub/hub-https" })).code).toBe(0);
  writeFileSync(join(home, ".config/systemd/user/fleet-hub-https.service"), "[Unit]\n");
  expect((await runFleet(["hub-https", "left"], { HOME: home, FLEET_UNDO: "hub/hub-https" })).code).toBe(3);
  expect((await runFleet(["peers", "left"], { HOME: home, FLEET_UNDO: "hub/peers" })).code).toBe(1);
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh/fleet-peers.conf"), "# Managed by Fleet peer access.\n");
  expect((await runFleet(["peers", "left"], { HOME: home, FLEET_UNDO: "hub/peers" })).code).toBe(0);
  expect((await runFleet(["peers", "remove"], { HOME: home, FLEET_UNDO: "hub/peers" })).code).toBe(0);
  expect(existsSync(join(home, ".ssh/fleet-peers.conf"))).toBe(false);
});
