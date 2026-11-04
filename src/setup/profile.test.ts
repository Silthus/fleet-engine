import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, isolateGit, tempDirs } from "../testing/git.ts";
import { defaultSources } from "./defaults.ts";
import { profilePath } from "./profile.ts";
import { fleetSetup, githubRepo, machineFile, pushedAnswers } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const starter = ["--preset", "starter", "--plan", "claude"];
const pushedFiles = (home: string) => git(githubRepo(home, "nora/fleet-profile"), "ls-tree", "--name-only", "main").split("\n");

describe("fleet setup profile", () => {
  test("asks once, creates the private profile repo, and pushes the answers, the shim, about me, and the guide", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, starter, ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  Fleet creates the private repo nora/fleet-profile in your GitHub account and pushes your answers there.");
    expect(result.output).toContain("  ✓ Created the private repo nora/fleet-profile");
    expect(pushedFiles(home)).toEqual(["README.md", "about-me.md", "fleet.json", "install.sh"]);
    expect(pushedAnswers(home)).toEqual({
      schema: 1,
      engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" },
      sources: defaultSources,
      settings: {},
      workflows: {},
      packs: ["pull-requests"],
      plan: "claude",
    });
    const guide = git(githubRepo(home, "nora/fleet-profile"), "show", "main:README.md");
    expect(guide).toContain("### pull-requests");
    expect(guide).toContain("| `pull-requests.freeReviews` |");
  });

  test("with Memory on it also creates the memory repo and points memory.repo at it", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("private repos nora/fleet-profile and nora/fleet-memory");
    expect(existsSync(githubRepo(home, "nora/fleet-memory"))).toBe(true);
    expect(pushedAnswers(home).settings).toEqual({ "memory.repo": "nora/fleet-memory" });
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
    expect(pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "orchestration", "communication"], plan: "both", settings: { "memory.repo": "nora/fleet-memory" } });
    expect(git(githubRepo(home, "nora/fleet-profile"), "rev-list", "--count", "main")).toBe("3");
  });

  test("refuses to take over a folder that is not the profile", async () => {
    const home = temp.make("home-");
    mkdirSync(profilePath(home), { recursive: true });
    const result = await fleetSetup(home, starter, ["", ""]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`fleet: ${profilePath(home)} exists and is not your profile. Move it away, then run fleet setup again.`);
  });
});
