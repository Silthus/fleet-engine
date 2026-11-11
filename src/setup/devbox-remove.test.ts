import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { engineRoot, fakeMachine, fleetSetup, machineFile, pushedAnswers, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const clientSettings = (home: string) => join(home, ".t3/userdata/client-settings.json");

async function macWithMachines(hub: string) {
  const home = temp.make("mac-home-");
  expect((await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"], [], fakeMachine(home), undefined, 0, "darwin")).code).toBe(0);
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  const profile = profilePath(home);
  const answers = JSON.parse(readFileSync(join(profile, "fleet.json"), "utf8"));
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ ...answers, hub }, null, 2) + "\n");
  await spawnGit(profile, "commit", "-q", "-am", "Name the hub");
  await spawnGit(profile, "push", "-q");
  const io = scripted([]);
  const fleet = (args: string[], box = fakeMachine(home)) => main(args, { home, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine } });
  for (const host of ["coder.old-hub", "coder.fleet-hub-2", "coder.fleet-node-1"]) expect(await fleet(["devbox", "add", host])).toBe(0);
  return { home, io, fleet };
}

const linkedHere = [
  { environmentId: "env-coder.old-hub", label: "old-hub" },
  { environmentId: "env-coder.fleet-hub-2", label: "fleet-hub-2" },
  { environmentId: "env-coder.fleet-node-1", label: "fleet-node-1" },
];

test("fleet devbox remove takes a replaced hub out of the profile and unlinks it in T3 Code here, also when the workspace is gone", async () => {
  const { home, io, fleet } = await macWithMachines("coder.fleet-hub-2");
  const box = fakeMachine(home, {}, { hereLinks: linkedHere });
  expect(await fleet(["devbox", "remove", "coder.old-hub"], box)).toBe(0);
  expect((await pushedAnswers(home)).devboxes).toEqual(["coder.fleet-hub-2", "coder.fleet-node-1"]);
  expect(machineFile(home).devboxes).toEqual(["coder.fleet-hub-2", "coder.fleet-node-1"]);
  expect(box.hereLinks().map((link) => link.environmentId)).toEqual(["env-coder.fleet-hub-2", "env-coder.fleet-node-1"]);
  expect(JSON.parse(readFileSync(clientSettings(home), "utf8")).loadBalancingWeights).toEqual({ "env-coder.fleet-hub-2": 0, "env-coder.fleet-node-1": 50 });
  expect(io.output()).toEndWith("✓ Removed coder.old-hub from your profile and unlinked it in T3 Code here. The hub stops its tunnel, disk watch and link to it at its next fleet update.");

  const gone = fakeMachine(home, {}, { hereLinks: linkedHere.slice(1), unreachable: ["coder.fleet-node-1"] });
  expect(await fleet(["devbox", "remove", "coder.fleet-node-1"], gone)).toBe(0);
  expect(gone.hereLinks().map((link) => link.environmentId)).toEqual(["env-coder.fleet-hub-2"]);
  expect((await pushedAnswers(home)).devboxes).toEqual(["coder.fleet-hub-2"]);
});

test("fleet devbox remove refuses the hub the profile names, and says what to unlink when T3 Code here does not know the host", async () => {
  const { home, io, fleet } = await macWithMachines("coder.fleet-hub-2");
  expect(await fleet(["devbox", "remove", "coder.fleet-hub-2"], fakeMachine(home, {}, { hereLinks: linkedHere }))).toBe(1);
  expect(io.output()).toContain("coder.fleet-hub-2 is your hub. Run fleet hub here on the new hub first, then fleet devbox remove coder.fleet-hub-2.");
  expect((await pushedAnswers(home)).devboxes).toContain("coder.fleet-hub-2");

  const unknown = fakeMachine(home, {}, { hereLinks: [], unreachable: ["coder.old-hub"] });
  expect(await fleet(["devbox", "remove", "coder.old-hub"], unknown)).toBe(0);
  expect((await pushedAnswers(home)).devboxes).toEqual(["coder.fleet-hub-2", "coder.fleet-node-1"]);
  expect(io.output()).toEndWith("· T3 Code here has no link to coder.old-hub that Fleet can find. When T3 Code still lists it, remove it in Settings → Environments.");

  expect(await fleet(["devbox", "remove", "coder.never-added"], fakeMachine(home))).toBe(1);
  expect(io.output()).toContain("coder.never-added is not one of your devboxes.");
  expect(await fleet(["devbox", "remove", "-oProxyCommand=x"])).toBe(2);
});
