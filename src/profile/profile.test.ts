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

describe("machine file", () => {
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
