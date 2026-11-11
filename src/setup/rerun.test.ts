import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { loadPacks } from "../pack/manifest.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { engineRoot, fakeMachine, fleetSetup, machineFile, pushedAnswers, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const onMac = (home: string, args: string[], replies: string[] = []) => fleetSetup(home, args, replies, fakeMachine(home), undefined, 0, "darwin");

/** A Mac with a finished starter setup whose profile then gained a pack, the Hub pack with its hub, and a workflow through fleet packs. The Hub pack's certificate step later stops a non-interactive rerun, after the profile is pushed. */
async function grownProfile() {
  const home = temp.make("home-");
  expect((await onMac(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"])).code).toBe(0);
  const io = scripted([]);
  const packs = (args: string[]) => main(["packs", ...args], { home, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: fakeMachine(home).machine } });
  expect(await packs(["--add", "communication", "--add", "hub", "--workflows", "pr-digest=on", "--set", "hub.alias=coder.fleet-hub"])).toBe(0);
  return home;
}

describe("a second fleet setup", () => {
  test("with no flags keeps the profile's packs, Hub pack, and workflows", async () => {
    const home = await grownProfile();
    await onMac(home, ["--non-interactive"]);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "communication", "hub"], workflows: { "pr-digest": true } });
  });

  test("with --add, --remove, or --workflows changes only what they name", async () => {
    const home = await grownProfile();
    const result = await onMac(home, ["--non-interactive", "--add", "memory", "--remove", "communication", "--workflows", "shell-guards=on", "--plan", "both"]);
    expect(result.output).toContain("✓ Pull requests, Hub, Memory");
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "hub", "memory"], workflows: { "pr-digest": true, "shell-guards": true }, plan: "both" });
  });

  test("with --preset picks that preset again, in place of the profile's packs", async () => {
    const home = await grownProfile();
    await onMac(home, ["--non-interactive", "--preset", "starter"]);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests"], workflows: {} });
  });
});

describe("a rerun that changes picks", () => {
  test("after a stop before the GitHub sign-in, --remove applies to the saved packs, not to the default preset", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], fakeMachine(home, { github: 1 }))).code).toBe(2);
    expect(machineFile(home).setup.draft.packs).toEqual(["pull-requests"]);
    const resumed = await fleetSetup(home, ["--non-interactive", "--remove", "pull-requests", "--plan", "claude", "--devbox", "skip"]);
    expect(resumed.output).not.toContain("fleet setup:");
    expect(await pushedAnswers(home)).toMatchObject({ packs: [] });
  });

  test("keeps a team workflow switch while the team's pack cannot be fetched", async () => {
    const home = temp.make("home-");
    const team = temp.make("team-");
    mkdirSync(join(team, "packs/posthog"), { recursive: true });
    writeFileSync(join(team, "packs/posthog/pack.json"), JSON.stringify({ schema: 1, name: "posthog", summary: "Team rules.", workflows: [{ id: "team-reviews", name: "Team reviews", default: true, sentence: "Agents ask the team for reviews." }] }));
    const fetched = async (ref: SourceRef): Promise<FetchedSource> => ({ ref, dir: team, packs: await loadPacks(team) });
    const offline = async (ref: SourceRef): Promise<FetchedSource> => ({ ref, error: "offline" });
    const first = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--workflows", "team-reviews=off", "--plan", "claude", "--devbox", "skip"], [], fakeMachine(home, {}, { org: true }), fetched);
    expect(first.code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "posthog"], workflows: { "team-reviews": false } });
    await fleetSetup(home, ["--non-interactive", "--add", "communication"], [], fakeMachine(home, {}, { org: true }), offline);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "posthog", "communication"], workflows: { "team-reviews": false } });
  });

  test("one by one keeps the profile's workflow switches", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--add", "guards", "--workflows", "package-age=on", "--plan", "claude", "--devbox", "skip"])).code).toBe(0);
    const edited = await fleetSetup(home, ["--add", "communication"], ["e", "4", ...Array(16).fill("")]);
    expect(edited.code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: expect.arrayContaining(["pull-requests", "guards", "communication"]), workflows: { "package-age": true } });
  });
});

/** A profile repo on GitHub that another machine set up and grew, and a home that has never run Fleet. The fake GitHub lives under the home, so the new machine shares it. */
async function newMachineWithProfile() {
  const home = temp.make("home-");
  expect((await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--add", "guards", "--workflows", "package-age=on", "--plan", "claude", "--devbox", "skip"])).code).toBe(0);
  rmSync(join(home, ".config/fleet"), { recursive: true });
  rmSync(profilePath(home), { recursive: true });
  return home;
}

describe("fleet setup on a new machine whose profile repo exists", () => {
  test("with no flags keeps the profile's packs and workflows", async () => {
    const home = await newMachineWithProfile();
    const result = await fleetSetup(home, [], Array(8).fill(""));
    expect(result.code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "guards"], workflows: { "package-age": true }, plan: "claude" });
  });

  test("with --add changes only the pack it names", async () => {
    const home = await newMachineWithProfile();
    expect((await fleetSetup(home, ["--non-interactive", "--add", "communication", "--devbox", "skip"])).code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "guards", "communication"], workflows: { "package-age": true }, plan: "claude" });
  });
});
