import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { defaultSources } from "./defaults.ts";
import { profileGuide, profilePath } from "./profile.ts";
import { fakeMachine, fleetSetup, githubRepo, machineFile, pushedAnswers } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const starter = ["--preset", "starter", "--plan", "claude"];
const pushedFiles = async (home: string, repo = "nora/fleet-profile") => (await spawnGit(githubRepo(home, repo), "ls-tree", "--name-only", "main")).split("\n");

function teamSource(): (ref: SourceRef) => Promise<FetchedSource> {
  const dir = temp.make("team-");
  mkdirSync(join(dir, "packs/posthog"), { recursive: true });
  writeFileSync(join(dir, "packs/posthog/pack.json"), JSON.stringify({ schema: 1, name: "posthog", summary: "Team rules.", profileOrg: "acme" }));
  return async (ref) => ({ ref, dir, packs: await loadPacks(dir) });
}

const teamSetup = (home: string, args: string[], replies: string[], options: { createFails?: string; createFailsAfterMaking?: string; publicRepos?: string[] } = {}) => fleetSetup(home, args, replies, fakeMachine(home, {}, { org: true, ...options }), teamSource());

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
    expect(guide).toContain("### Pull requests");
    expect(guide).toContain("| `pull-requests.freeReviews` |");
  });

  test("with a team pack that names a profile org, creates the profile there and says where", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  Fleet creates the private repo acme/fleet-profile-nora in the acme GitHub org, private to the org, and pushes your answers there.");
    expect(result.output).toContain("  ✓ Created the private repo acme/fleet-profile-nora in the acme org");
    expect(result.output).toContain("  Profile         acme/fleet-profile-nora, private.");
    expect(existsSync(githubRepo(home, "nora/fleet-profile"))).toBe(false);
    expect(await pushedFiles(home, "acme/fleet-profile-nora")).toEqual(["README.md", "about-me.md", "fleet.json", "install.sh"]);
    expect((await pushedAnswers(home, "acme/fleet-profile-nora")).packs).toContain("posthog");
    expect(await spawnGit(githubRepo(home, "acme/fleet-profile-nora"), "show", "main:README.md")).toContain("This repo lives in the acme org, where teammates may read it, so keep secrets out of it.");

    rmSync(join(home, ".config/fleet"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });
    const second = await teamSetup(home, starter, [""]);
    expect(second.code).toBe(0);
    expect(second.output).toContain("  ✓ Reusing your repo acme/fleet-profile-nora");
  });

  test("with a team pack, keeps an existing personal profile and says how to move it to the org", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, starter, ["", ""])).code).toBe(0);
    rmSync(join(home, ".config/fleet"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });

    const rerun = await teamSetup(home, starter, [""]);
    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo nora/fleet-profile");
    expect(rerun.output).toContain("  · Your team keeps profiles in the acme org. To move yours there, run:");
    expect(rerun.output).toContain("      gh api -X POST repos/nora/fleet-profile/transfer -f new_owner=acme -f new_name=fleet-profile-nora");
    expect(rerun.output).toContain(`      git -C ${profilePath(home)} remote set-url origin https://github.com/acme/fleet-profile-nora.git`);
    expect(existsSync(githubRepo(home, "acme/fleet-profile-nora"))).toBe(false);
    expect((await pushedAnswers(home)).packs).toContain("posthog");
  });

  test("with a team pack whose org refuses the repo, creates the profile in the user's account and says why", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", ""], { createFails: "acme" });
    expect(result.code).toBe(0);
    expect(result.output).toContain("  · The acme org did not let you create acme/fleet-profile-nora (you cannot create repos in acme), so Fleet uses your own account.");
    expect(result.output).toContain("  ✓ Created the private repo nora/fleet-profile");
    expect(existsSync(githubRepo(home, "acme/fleet-profile-nora"))).toBe(false);
    expect((await pushedAnswers(home)).packs).toContain("posthog");
  });

  test("with a team pack, refuses an org profile repo that someone made public, and pushes nothing", async () => {
    const home = temp.make("home-");
    mkdirSync(githubRepo(home, "acme/fleet-profile-nora"), { recursive: true });
    await spawnGit(githubRepo(home, "acme/fleet-profile-nora"), "init", "-q", "--bare", "-b", "main");
    const result = await teamSetup(home, starter, [""], { publicRepos: ["acme/fleet-profile-nora"] });
    expect(result.code).toBe(1);
    expect(result.output).toContain("fleet: acme/fleet-profile-nora is not private. Make it private, then run fleet setup again.");
    expect(existsSync(profilePath(home))).toBe(false);
  });

  test("keeps the org profile this machine already uses after the team pack is removed", async () => {
    const home = temp.make("home-");
    expect((await teamSetup(home, starter, ["", ""])).code).toBe(0);
    const rerun = await teamSetup(home, ["--remove", "posthog"], [""]);
    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo acme/fleet-profile-nora");
    expect(existsSync(githubRepo(home, "nora/fleet-profile"))).toBe(false);
    expect((await pushedAnswers(home, "acme/fleet-profile-nora")).packs).not.toContain("posthog");
  });

  test("uses the org repo when its creation reports a failure but the repo was made", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", ""], { createFailsAfterMaking: "acme" });
    expect(result.code).toBe(0);
    expect(result.output).toContain("  ✓ Created the private repo acme/fleet-profile-nora in the acme org");
    expect(existsSync(githubRepo(home, "nora/fleet-profile"))).toBe(false);
    expect((await pushedAnswers(home, "acme/fleet-profile-nora")).packs).toContain("posthog");
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
