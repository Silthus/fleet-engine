import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { defaultSources } from "./defaults.ts";
import { profileGuide, profilePath } from "./profile.ts";
import { fleetSetup, githubRepo, machineFile, pushedAnswers } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const starter = ["--preset", "starter", "--plan", "claude"];
const pushedFiles = async (home: string) => (await spawnGit(githubRepo(home, "nora/fleet-profile"), "ls-tree", "--name-only", "main")).split("\n");

describe("fleet setup profile", () => {
  test("asks once, creates the private profile repo, and pushes the answers, the shim, about me, and the guide", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, starter, ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  Fleet creates the private repo nora/fleet-profile in your GitHub account and pushes your answers there.");
    expect(result.output).toContain("  ✓ Created the private repo nora/fleet-profile");
    expect(await pushedFiles(home)).toEqual(["README.md", "about-me.md", "fleet.json", "install.sh"]);
    expect(await pushedAnswers(home)).toEqual({
      schema: 1,
      engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" },
      sources: defaultSources,
      settings: {},
      workflows: {},
      packs: ["pull-requests"],
      plan: "claude",
    });
    const guide = await spawnGit(githubRepo(home, "nora/fleet-profile"), "show", "main:README.md");
    expect(guide).toContain("### pull-requests");
    expect(guide).toContain("| `pull-requests.freeReviews` |");
  });

  test("heads a pack's section in the profile guide with its title", () => {
    const guide = profileGuide([{ schema: 1, name: "team", title: "Team Tools", summary: "Team rules.", settings: [{ key: "team.region", question: "Which region?", type: "string" }] }]);
    expect(guide).toContain("### Team Tools");
  });

  test("with Memory on it also creates the memory repo and points memory.repo at it", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("private repos nora/fleet-profile and nora/fleet-memory");
    expect(existsSync(githubRepo(home, "nora/fleet-memory"))).toBe(true);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": "nora/fleet-memory" });
  });

  test("n creates nothing and keeps the draft for the next run", async () => {
    const home = temp.make("home-");
    const declined = await fleetSetup(home, starter, ["", "n"]);
    expect(declined.code).toBe(130);
    expect(declined.output).toContain("  Nothing was created.");
    expect(declined.output).toEndWith("Stopped. Run fleet setup again to pick up at Make your profile.");
    expect(existsSync(join(home, "github-remotes"))).toBe(false);
    expect(machineFile(home).setup.draft).toMatchObject({ packs: ["pull-requests"], plan: "claude" });
  });

  test("a rerun on another machine reuses the repos without asking, and the new answers win", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], ["", ""])).code).toBe(0);
    rmSync(join(home, ".config/fleet"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });

    const rerun = await fleetSetup(home, ["--preset", "everyday", "--plan", "both"], [""]);
    expect(rerun.code).toBe(0);
    expect(rerun.prompts).toEqual(["Press ↵ to keep them, or e to change them: "]);
    expect(rerun.output).toContain("  ✓ Reusing your repo nora/fleet-profile");
    expect(rerun.output).not.toContain("Created the private repo");
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "orchestration", "communication"], plan: "both", settings: { "memory.repo": "nora/fleet-memory" } });
    expect(await spawnGit(githubRepo(home, "nora/fleet-profile"), "rev-list", "--count", "main")).toBe("3");
  });

  test("uses a memory repo named on the command, and a second machine keeps the one the profile names", async () => {
    const home = temp.make("home-");
    const custom = await fleetSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude", "--set", "memory.repo=nora/custom-notes"], ["", ""]);
    expect(custom.code).toBe(0);
    expect(custom.output).toContain("private repos nora/fleet-profile and nora/custom-notes");
    expect(existsSync(githubRepo(home, "nora/custom-notes"))).toBe(true);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": "nora/custom-notes" });

    rmSync(join(home, ".config/fleet"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });
    const second = await fleetSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], [""]);
    expect(second.code).toBe(0);
    expect(existsSync(githubRepo(home, "nora/fleet-memory"))).toBe(false);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": "nora/custom-notes" });
  });

  test("pushes the start files a stopped run wrote but did not commit", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, starter, ["", ""])).code).toBe(0);
    const dir = profilePath(home);
    await spawnGit(dir, "rm", "-q", "--cached", "README.md");
    await spawnGit(dir, "commit", "-q", "-m", "Lose the guide");
    await spawnGit(dir, "push", "-q");
    const rerun = await fleetSetup(home, ["--set", "pull-requests.freeReviews=2"]);
    expect(rerun.code).toBe(0);
    expect(await pushedFiles(home)).toContain("README.md");
  });

  test("refuses a profile folder cloned from a repo with a longer name", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, starter, ["", ""])).code).toBe(0);
    await spawnGit(profilePath(home), "remote", "set-url", "origin", "https://github.com/nora/fleet-profile-public.git");
    const rerun = await fleetSetup(home, ["--set", "pull-requests.freeReviews=2"]);
    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`fleet: ${profilePath(home)} is a clone of https://github.com/nora/fleet-profile-public.git, not nora/fleet-profile.`);
  });

  test("refuses to take over a folder that is not the profile", async () => {
    const home = temp.make("home-");
    mkdirSync(profilePath(home), { recursive: true });
    const result = await fleetSetup(home, starter, ["", ""]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`fleet: ${profilePath(home)} exists and is not your profile. Move it away, then run fleet setup again.`);
  });
});
