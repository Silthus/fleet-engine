import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackManifest, ProfileFile } from "../pack/types.ts";
import { git, isolateGit, tempDirs } from "../testing/git.ts";
import { activeChoices, loadMachine, loadProfile, ProfileError, saveAnswers, saveMachine, workflowOverrides } from "./profile.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const packs: PackManifest[] = [
  {
    schema: 1,
    name: "orchestration",
    summary: "Planning maps.",
    workflows: [
      { id: "maps", name: "Maps", sentence: "Plan work as maps.", default: true },
      { id: "quality-loop", name: "Quality loop", sentence: "Small PRs that improve code.", default: false },
    ],
  },
];

const profile: ProfileFile = {
  schema: 1,
  engine: { repo: "Silthus/fleet-engine", ref: "v0.1.0", channel: "release" },
  sources: [],
  packs: ["orchestration"],
  plan: "both",
  settings: {},
  workflows: {},
};

function profileRepo(file: unknown = profile) {
  const dir = temp.make("profile-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "fleet.json"), JSON.stringify(file, null, 2) + "\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Start");
  return dir;
}

describe("profile", () => {
  test("rejects a schema it does not know", async () => {
    const dir = profileRepo({ ...profile, schema: 3 });
    expect(loadProfile(dir)).rejects.toThrow(new ProfileError(`${join(dir, "fleet.json")}: unknown schema 3`));
  });

  test("loads about-me.md when it exists", async () => {
    const dir = profileRepo();
    writeFileSync(join(dir, "about-me.md"), "I like small PRs.\n");
    expect((await loadProfile(dir)).aboutMe).toBe("I like small PRs.\n");
  });

  test("round-trips workflow overrides in both directions and drops defaults", async () => {
    const dir = profileRepo();
    const choices = { maps: false, "quality-loop": true };
    await saveAnswers(dir, { workflows: workflowOverrides(choices, packs) });
    const saved = await loadProfile(dir);
    expect(saved.workflows).toEqual({ maps: false, "quality-loop": true });
    expect(activeChoices(saved, packs)).toEqual(choices);

    await saveAnswers(dir, { workflows: workflowOverrides({ maps: true, "quality-loop": true }, packs) });
    expect((await loadProfile(dir)).workflows).toEqual({ "quality-loop": true });
    expect(git(dir, "log", "--format=%s")).toBe("Save Fleet answers\nSave Fleet answers\nStart");
  });

  test("keeps answers it was not given", async () => {
    const dir = profileRepo({ ...profile, settings: { "orchestration.tracker": "me/fleet-profile" } });
    await saveAnswers(dir, { plan: "claude" });
    const saved = JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8"));
    expect(saved).toMatchObject({ plan: "claude", settings: { "orchestration.tracker": "me/fleet-profile" } });
  });
});

describe("saving answers", () => {
  test("commits only fleet.json and leaves other staged files staged", async () => {
    const dir = profileRepo();
    writeFileSync(join(dir, "notes.txt"), "private\n");
    git(dir, "add", "notes.txt");
    await saveAnswers(dir, { plan: "claude" });
    expect(git(dir, "show", "--name-only", "--format=", "HEAD")).toBe("fleet.json");
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("notes.txt");
  });

  test("merges settings key by key", async () => {
    const dir = profileRepo({ ...profile, settings: { "team.one": 1, "team.two": 2 } });
    await saveAnswers(dir, { settings: { "team.one": 3 } });
    expect((await loadProfile(dir)).settings).toEqual({ "team.one": 3, "team.two": 2 });
  });

  test("refuses to rewrite a profile of an unknown schema", async () => {
    const dir = profileRepo({ ...profile, schema: 9 });
    expect(saveAnswers(dir, { plan: "claude" })).rejects.toThrow("unknown schema 9");
    expect(JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8")).schema).toBe(9);
  });

  test("fails when Git cannot stage fleet.json", async () => {
    const dir = profileRepo();
    git(dir, "rm", "-q", "--cached", "fleet.json");
    writeFileSync(join(dir, ".gitignore"), "fleet.json\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "-q", "-m", "Ignore");
    expect(saveAnswers(dir, { plan: "claude" })).rejects.toThrow("could not stage fleet.json");
  });

  test("pushes when asked, even when nothing changed", async () => {
    const remote = temp.make("remote-");
    git(remote, "init", "-q", "--bare", "-b", "main");
    const dir = profileRepo();
    git(dir, "remote", "add", "origin", remote);
    git(dir, "push", "-q", "-u", "origin", "main");
    await saveAnswers(dir, { plan: "claude" });
    await saveAnswers(dir, { plan: "claude" }, { push: true });
    expect(git(remote, "rev-parse", "main")).toBe(git(dir, "rev-parse", "HEAD"));
  });

  test("rejects a profile with invalid fields", async () => {
    expect(loadProfile(profileRepo({ ...profile, workflows: { maps: "false" } }))).rejects.toThrow("workflows must map ids to true or false");
    expect(loadProfile(profileRepo({ schema: 1 }))).rejects.toThrow("engine needs a repo");
  });
});

describe("machine file", () => {
  test("rejects an unknown role", async () => {
    const home = temp.make("home-");
    await saveMachine(home, { schema: 1, role: "linux" });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "toaster" }));
    expect(loadMachine(home)).rejects.toThrow("role must be mac, devbox, linux, or hub");
  });

  test("round-trips setup progress and draft answers", async () => {
    const home = temp.make("home-");
    expect(await loadMachine(home)).toBeUndefined();
    await saveMachine(home, { schema: 1, role: "mac", setup: { done: ["github", "packs"], draft: { packs: ["orchestration"], plan: "claude" } } });
    expect(await loadMachine(home)).toEqual({ schema: 1, role: "mac", setup: { done: ["github", "packs"], draft: { packs: ["orchestration"], plan: "claude" } } });
  });

  test("rejects a schema it does not know", async () => {
    const home = temp.make("home-");
    await saveMachine(home, { schema: 1, role: "linux" });
    const path = join(home, ".config/fleet/machine.json");
    writeFileSync(path, JSON.stringify({ schema: 9, role: "linux" }));
    expect(loadMachine(home)).rejects.toThrow(`${path}: unknown schema 9`);
  });
});
