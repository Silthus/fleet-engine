import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { loadPacks } from "../pack/manifest.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { engineRoot, fakeMachine, fleetSetup, githubRepo, machineFile, pushedAnswers, savedAnswers, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const onMac = (home: string, args: string[], replies: string[] = []) => fleetSetup(home, args, replies, fakeMachine(home), undefined, 0, "darwin");

async function grownProfile() {
  const home = temp.make("home-");
  expect((await onMac(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"])).code).toBe(0);
  const io = scripted([]);
  const packs = (args: string[]) => main(["packs", ...args], { home, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: fakeMachine(home).machine } });
  expect(await packs(["--add", "communication", "--add", "hub", "--workflows", "pr-digest=on", "--set", "hub.alias=coder.fleet-hub"])).toBe(0);
  return home;
}

async function packsAfterSetup() {
  const home = temp.make("home-");
  expect((await onMac(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"])).code).toBe(0);
  return {
    home,
    packs: async (args: string[], options: Parameters<typeof fakeMachine>[2] = {}) => {
      const io = scripted([]);
      const box = fakeMachine(home, {}, options);
      const code = await main(["packs", ...args], { home, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: box.machine } });
      return { code, output: io.output(), gh: box.calls.filter((call) => call.command[0] === "gh") };
    },
  };
}

describe("fleet packs --add memory", () => {
  test("creates the private memory repo, as setup does, and points memory.repo at it", async () => {
    const { home, packs } = await packsAfterSetup();
    const added = await packs(["--add", "memory"]);
    expect(added.code).toBe(0);
    expect(added.output).toContain("✓ Created the private repo nora/fleet-memory");
    expect(existsSync(githubRepo(home, "nora/fleet-memory"))).toBe(true);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "memory"], settings: { "memory.repo": "nora/fleet-memory" } });
  });

  test("reuses the memory repo the profile names when the pack comes back", async () => {
    const { home, packs } = await packsAfterSetup();
    expect((await packs(["--add", "memory", "--set", "memory.repo=nora/custom-notes"])).code).toBe(0);
    expect((await packs(["--remove", "memory"])).code).toBe(0);
    const back = await packs(["--add", "memory"]);
    expect(back.output).toContain("✓ Reusing your repo nora/custom-notes");
    expect(existsSync(githubRepo(home, "nora/fleet-memory"))).toBe(false);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "memory"], settings: { "memory.repo": "nora/custom-notes" } });
  });

  test("makes no repo when the same command removes Memory again", async () => {
    const { home, packs } = await packsAfterSetup();
    const result = await packs(["--add", "memory", "--remove", "memory"]);
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(existsSync(githubRepo(home, "nora/fleet-memory"))).toBe(false);
    expect((await pushedAnswers(home)).packs).toEqual(["pull-requests"]);
  });

  test("refuses a public memory repo and changes nothing", async () => {
    const { home, packs } = await packsAfterSetup();
    await spawnGit(home, "init", "-q", "--bare", githubRepo(home, "nora/fleet-memory"));
    const before = savedAnswers(home);
    const result = await packs(["--add", "memory"], { publicRepos: ["nora/fleet-memory"] });
    expect(result.code).toBe(1);
    expect(result.output).toContain("fleet: nora/fleet-memory is not private, and agents write notes about you there. Make it private, or name a private repo with --set memory.repo=<owner/name>.");
    expect(savedAnswers(home)).toEqual(before);
    expect(await pushedAnswers(home)).toEqual(before);
  });

  test("stops before it saves when GitHub refuses to make the repo", async () => {
    const { home, packs } = await packsAfterSetup();
    const before = savedAnswers(home);
    const result = await packs(["--add", "memory"], { createFails: "nora" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("fleet: gh repo create failed: GraphQL: you cannot create repos in nora");
    expect(savedAnswers(home)).toEqual(before);
    expect(await pushedAnswers(home)).toEqual(before);
  });
});

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

async function withTeamSwitch() {
  const home = temp.make("home-");
  const team = temp.make("team-");
  mkdirSync(join(team, "packs/posthog"), { recursive: true });
  writeFileSync(join(team, "packs/posthog/pack.json"), JSON.stringify({ schema: 1, name: "posthog", summary: "Team rules.", workflows: [{ id: "team-reviews", name: "Team reviews", default: true, sentence: "Agents ask the team for reviews." }] }));
  const fetched = async (ref: SourceRef): Promise<FetchedSource> => ({ ref, dir: team, packs: await loadPacks(team) });
  expect((await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--workflows", "team-reviews=off", "--plan", "claude", "--devbox", "skip"], [], fakeMachine(home, {}, { org: true }), fetched)).code).toBe(0);
  expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "posthog"], workflows: { "team-reviews": false } });
  return home;
}

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
    const home = await withTeamSwitch();
    const offline = async (ref: SourceRef): Promise<FetchedSource> => ({ ref, error: "offline" });
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

async function newMachineWithProfile() {
  const home = temp.make("home-");
  expect((await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--add", "guards", "--workflows", "package-age=on", "--plan", "claude", "--devbox", "skip"])).code).toBe(0);
  return forgetMachine(home);
}

function forgetMachine(home: string) {
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

  test("keeps the plan a run before the GitHub sign-in already set with --plan", async () => {
    const home = await newMachineWithProfile();
    const args = ["--non-interactive", "--preset", "starter", "--plan", "codex", "--devbox", "skip"];
    expect((await fleetSetup(home, args, [], fakeMachine(home, { github: 1 }))).code).toBe(2);
    expect((await fleetSetup(home, args)).code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests"], plan: "codex" });
  });

  test("keeps the plan a stopped run set with --plan when the next run leaves it out", async () => {
    const home = await newMachineWithProfile();
    expect((await fleetSetup(home, ["--non-interactive", "--plan", "codex", "--devbox", "skip"], [], fakeMachine(home, { github: 1 }))).code).toBe(2);
    expect((await fleetSetup(home, ["--non-interactive", "--devbox", "skip"])).code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "guards"], plan: "codex" });
  });

  test("takes the profile's plan when no run named one", async () => {
    const home = await newMachineWithProfile();
    expect((await fleetSetup(home, ["--non-interactive", "--devbox", "skip"], [], fakeMachine(home, { github: 1 }))).code).toBe(2);
    expect((await fleetSetup(home, ["--non-interactive", "--devbox", "skip"])).code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "guards"], plan: "claude" });
  });

  test("keeps a workflow switch of a team source the person is no longer a member of", async () => {
    const home = forgetMachine(await withTeamSwitch());
    expect((await fleetSetup(home, ["--non-interactive", "--add", "communication", "--devbox", "skip"])).code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "posthog", "communication"], workflows: { "team-reviews": false } });
  });
});
