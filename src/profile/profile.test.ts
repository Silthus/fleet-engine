import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackManifest, ProfileFile } from "../pack/types.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { activeChoices, loadMachine, loadProfile, ProfileError, saveAnswers, saveMachine, thisMachine, workflowOverrides } from "./profile.ts";

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

async function profileRepo(file: unknown = profile) {
  const dir = temp.make("profile-");
  await spawnGit(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "fleet.json"), JSON.stringify(file, null, 2) + "\n");
  await spawnGit(dir, "add", ".");
  await spawnGit(dir, "commit", "-q", "-m", "Start");
  return dir;
}

describe("profile", () => {
  test("rejects a schema it does not know", async () => {
    const dir = await profileRepo({ ...profile, schema: 3 });
    expect(loadProfile(dir)).rejects.toThrow(new ProfileError(`${join(dir, "fleet.json")}: unknown schema 3`));
  });

  test("loads about-me.md when it exists", async () => {
    const dir = await profileRepo();
    writeFileSync(join(dir, "about-me.md"), "I like small PRs.\n");
    expect((await loadProfile(dir)).aboutMe).toBe("I like small PRs.\n");
  });

  test("round-trips workflow overrides in both directions and drops defaults", async () => {
    const dir = await profileRepo();
    const choices = { maps: false, "quality-loop": true };
    await saveAnswers(dir, { workflows: workflowOverrides(choices, packs) });
    const saved = await loadProfile(dir);
    expect(saved.workflows).toEqual({ maps: false, "quality-loop": true });
    expect(activeChoices(saved, packs)).toEqual(choices);

    await saveAnswers(dir, { workflows: workflowOverrides({ maps: true, "quality-loop": true }, packs) });
    expect((await loadProfile(dir)).workflows).toEqual({ "quality-loop": true });
    expect(await spawnGit(dir, "log", "--format=%s")).toBe("Save Fleet answers\nSave Fleet answers\nStart");
  });

  test("keeps answers it was not given", async () => {
    const dir = await profileRepo({ ...profile, settings: { "orchestration.tracker": "me/fleet-profile" } });
    await saveAnswers(dir, { plan: "claude" });
    const saved = JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8"));
    expect(saved).toMatchObject({ plan: "claude", settings: { "orchestration.tracker": "me/fleet-profile" } });
  });
});

describe("saving answers", () => {
  test("commits only fleet.json and leaves other staged files staged", async () => {
    const dir = await profileRepo();
    writeFileSync(join(dir, "notes.txt"), "private\n");
    await spawnGit(dir, "add", "notes.txt");
    await saveAnswers(dir, { plan: "claude" });
    expect(await spawnGit(dir, "show", "--name-only", "--format=", "HEAD")).toBe("fleet.json");
    expect(await spawnGit(dir, "diff", "--cached", "--name-only")).toBe("notes.txt");
  });

  test("merges settings key by key", async () => {
    const dir = await profileRepo({ ...profile, settings: { "team.one": 1, "team.two": 2 } });
    await saveAnswers(dir, { settings: { "team.one": 3 } });
    expect((await loadProfile(dir)).settings).toEqual({ "team.one": 3, "team.two": 2 });
  });

  test("refuses to rewrite a profile of an unknown schema", async () => {
    const dir = await profileRepo({ ...profile, schema: 9 });
    expect(saveAnswers(dir, { plan: "claude" })).rejects.toThrow("unknown schema 9");
    expect(JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8")).schema).toBe(9);
  });

  test("fails when Git cannot stage fleet.json", async () => {
    const dir = await profileRepo();
    await spawnGit(dir, "rm", "-q", "--cached", "fleet.json");
    writeFileSync(join(dir, ".gitignore"), "fleet.json\n");
    await spawnGit(dir, "add", ".gitignore");
    await spawnGit(dir, "commit", "-q", "-m", "Ignore");
    expect(saveAnswers(dir, { plan: "claude" })).rejects.toThrow("could not stage fleet.json");
  });

  test("pushes when asked, even when nothing changed", async () => {
    const remote = temp.make("remote-");
    await spawnGit(remote, "init", "-q", "--bare", "-b", "main");
    const dir = await profileRepo();
    await spawnGit(dir, "remote", "add", "origin", remote);
    await spawnGit(dir, "push", "-q", "-u", "origin", "main");
    await saveAnswers(dir, { plan: "claude" });
    await saveAnswers(dir, { plan: "claude" }, { push: true });
    expect(await spawnGit(remote, "rev-parse", "main")).toBe(await spawnGit(dir, "rev-parse", "HEAD"));
  });

  async function profileBehind() {
    const remote = temp.make("remote-");
    await spawnGit(remote, "init", "-q", "--bare", "-b", "main");
    const dir = await profileRepo();
    await spawnGit(dir, "remote", "add", "origin", remote);
    await spawnGit(dir, "push", "-q", "-u", "origin", "main");
    const other = temp.make("other-");
    await spawnGit(other, "clone", "-q", remote, ".");
    const elsewhere = async (change: (file: Record<string, unknown>) => Record<string, unknown>) => {
      const file = JSON.parse(readFileSync(join(other, "fleet.json"), "utf8"));
      writeFileSync(join(other, "fleet.json"), JSON.stringify(change(file), null, 2) + "\n");
      await spawnGit(other, "commit", "-q", "-am", "Elsewhere");
      await spawnGit(other, "push", "-q");
    };
    return { dir, remote, elsewhere };
  }

  test("takes what another machine pushed before it saves, so a change here keeps the hub named on the hub", async () => {
    const { dir, remote, elsewhere } = await profileBehind();
    await elsewhere((file) => ({ ...file, hub: "coder.fleet-hub" }));
    await saveAnswers(dir, { packs: ["hub"] }, { push: true });
    expect(JSON.parse(await spawnGit(remote, "show", "main:fleet.json"))).toMatchObject({ hub: "coder.fleet-hub", packs: ["hub"] });
    expect(await spawnGit(remote, "rev-parse", "main")).toBe(await spawnGit(dir, "rev-parse", "HEAD"));
  });

  test("a change that clashes with one another machine pushed says why and how to recover, and leaves the profile as it was", async () => {
    const { dir, elsewhere } = await profileBehind();
    await saveAnswers(dir, { plan: "codex" });
    await elsewhere((file) => ({ ...file, plan: "claude" }));
    const error = await saveAnswers(dir, { packs: ["hub"] }, { push: true }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as Error).message).toBe(`${dir}: could not take the changes another machine pushed. ${dir} and its remote both have changes the other lacks. Run git -C ${dir} pull --rebase, then try again.`);
    expect(await spawnGit(dir, "status", "--porcelain")).toBe("");
    expect(JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8")).plan).toBe("codex");
  });

  test("a profile with changes it has not committed takes nothing and saves nothing, and says to commit or discard them", async () => {
    const { dir, remote, elsewhere } = await profileBehind();
    await elsewhere((file) => ({ ...file, hub: "coder.fleet-hub" }));
    writeFileSync(join(dir, "about-me.md"), "Hi\n");
    await spawnGit(dir, "add", "about-me.md");
    const before = await spawnGit(dir, "rev-parse", "HEAD");
    const error = await saveAnswers(dir, { packs: ["hub"] }, { push: true }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as Error).message).toBe(`${dir}: could not take the changes another machine pushed, because ${dir} has changes that are not committed. Commit or discard them, then try again.`);
    expect(await spawnGit(dir, "rev-parse", "HEAD")).toBe(before);
    expect(JSON.parse(await spawnGit(remote, "show", "main:fleet.json")).packs).toEqual(["orchestration"]);
  });

  test("a profile whose Git stashes changes on its own before a pull still refuses them, and keeps fleet.json readable", async () => {
    const { dir, elsewhere } = await profileBehind();
    await spawnGit(dir, "config", "rebase.autoStash", "true");
    await elsewhere((file) => ({ ...file, plan: "claude" }));
    const edited = JSON.stringify({ ...profile, plan: "codex" }, null, 2) + "\n";
    writeFileSync(join(dir, "fleet.json"), edited);
    const error = await saveAnswers(dir, { packs: ["hub"] }, { push: true }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as Error).message).toContain(`because ${dir} has changes that are not committed.`);
    expect(readFileSync(join(dir, "fleet.json"), "utf8")).toBe(edited);
  });

  test("a failed push never shows the credentials in the remote's URL", async () => {
    const dir = await profileRepo();
    await spawnGit(dir, "remote", "add", "origin", "http://nora:hunter2@127.0.0.1:1/nora/fleet-profile.git?access_token=EXAMPLE_TOKEN");
    await spawnGit(dir, "config", "branch.main.remote", "origin");
    await spawnGit(dir, "config", "branch.main.merge", "refs/heads/main");
    const error = await saveAnswers(dir, { plan: "claude" }, { push: true }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as Error).message).toContain("http://127.0.0.1:1/nora/fleet-profile.git");
    expect((error as Error).message).not.toMatch(/hunter2|EXAMPLE_TOKEN|nora:/);
  });

  test("rejects a profile with invalid fields", async () => {
    expect(loadProfile(await profileRepo({ ...profile, workflows: { maps: "false" } }))).rejects.toThrow("workflows must map ids to true or false");
    expect(loadProfile(await profileRepo({ schema: 1 }))).rejects.toThrow("engine needs a repo");
    expect(loadProfile(await profileRepo({ ...profile, overrides: { models: [{ role: "review", model: "x" }] } }))).rejects.toThrow("overrides.models must list rows");
    expect(loadProfile(await profileRepo({ ...profile, overrides: { config: [{ provider: "claude", key: "model", value: "x", plans: {} }] } }))).rejects.toThrow("overrides.config[0]: plans must list claude, codex, or both");
    expect(loadProfile(await profileRepo({ ...profile, overrides: { config: [{ provider: "nope", key: "model", value: "x" }] } }))).rejects.toThrow("overrides.config[0]: needs a provider and a key");
    expect(loadProfile(await profileRepo({ ...profile, overrides: { config: [{ provider: "claude", key: "model", value: "x", after: "ready" }] } }))).rejects.toThrow("overrides.config[0]: after names a pack's check, so only a pack's own config item can wait for one");
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

  test("a new Mac is a mac and never a Coder devbox, even with Coder's variables set", () => {
    const coder = { CODER_AGENT_URL: "https://coder.example", CODER: "true" };
    expect(thisMachine(undefined, "darwin", {}, "laptop")).toEqual({ schema: 1, role: "mac", name: "laptop" });
    expect(thisMachine(undefined, "darwin", coder, "laptop")).toEqual({ schema: 1, role: "mac", name: "laptop" });
    expect(thisMachine({ schema: 1, role: "mac", name: "octo-mac", profileDir: "/Users/octo/fleet-profile" }, "darwin", coder, "laptop")).toEqual({ schema: 1, role: "mac", name: "octo-mac", profileDir: "/Users/octo/fleet-profile" });
    expect(thisMachine(undefined, "linux", coder, "not a host")).toEqual({ schema: 1, role: "devbox", coder: true });
  });

  test("rejects a schema it does not know", async () => {
    const home = temp.make("home-");
    await saveMachine(home, { schema: 1, role: "linux" });
    const path = join(home, ".config/fleet/machine.json");
    writeFileSync(path, JSON.stringify({ schema: 9, role: "linux" }));
    expect(loadMachine(home)).rejects.toThrow(`${path}: unknown schema 9`);
  });
});
