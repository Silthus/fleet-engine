import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { git, gitEnv, tempDirs } from "../../../../src/testing/git.ts";
import { writeHome } from "../testing.ts";
import { dreamCommand } from "./command.ts";
import { dreamSettings, note, quietIo, realGit } from "./testing.ts";

const temp = tempDirs();
afterAll(() => temp.cleanup());
const fakeToken = () => "ghp_" + "a1B2c3D4e5".repeat(4).slice(0, 36);

function commit(dir: string, message: string, files: Record<string, string>) {
  writeHome(dir, files);
  git(dir, "add", "-A");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

function dreamWorktree(subtree = "memory") {
  const home = temp.make("fleet-dream-publish-");
  const origin = join(home, "origin.git");
  const laptop = join(home, "laptop");
  const prefix = subtree ? `${subtree}/` : "";
  git(home, "init", "-q", "--bare", "-b", "main", origin);
  git(home, "clone", "-q", origin, laptop);
  commit(laptop, "memory: laptop", { "README.md": "# Notes\n", [`${prefix}MEMORY.md`]: "# Memory index\n", [`${prefix}tech/rule.md`]: note("rule") });
  git(laptop, "push", "-q", "origin", "HEAD:main");
  const checkout = join(home, subtree ? ".agents/memory-repo" : ".agents/memory");
  git(home, "clone", "-q", origin, checkout);
  if (subtree) symlinkSync(join(checkout, subtree), join(home, ".agents/memory"));
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub" }) });
  const worktree = join(home, ".local/state/fleet/dream/2026-11-05/memory");
  git(checkout, "worktree", "add", "-q", worktree, "-b", "dream/2026-11-05", "origin/main");
  const settings = { ...dreamSettings, "memory.subtree": subtree };
  return { home, laptop, worktree, prefix, io: () => quietIo(home, { git: realGit, env: { FLEET_SETTINGS: JSON.stringify(settings) } }) };
}

const mainOf = (home: string, ...args: string[]) => git(home, "--git-dir", join(home, "origin.git"), ...args);

test("publish rebases the Dream's commits onto the memory repo's newer main and pushes them", async () => {
  const { home, laptop, worktree, prefix, io } = dreamWorktree();
  commit(worktree, "Condense: rule", { "memory/tech/rule.md": note("rule", {}, "Shorter.") });
  commit(worktree, "Report: 2026-11-05", { "dreams/2026-11-05.md": "1 session from hub.\n" });
  commit(laptop, "memory: laptop", { [`${prefix}tech/new.md`]: note("new") });
  git(laptop, "push", "-q", "origin", "HEAD:main");
  const { io: dream, printed } = io();

  expect(await dreamCommand(["publish", worktree], dream)).toBe(0);

  expect(printed).toEqual([`Fleet dream: pushed ${git(worktree, "rev-parse", "--short", "HEAD")} to main.`]);
  expect(mainOf(home, "log", "--format=%s", "main")).toBe(["Report: 2026-11-05", "Condense: rule", "memory: laptop", "memory: laptop"].join("\n"));
  expect(mainOf(home, "show", "main:memory/tech/rule.md")).toContain("Shorter.");
  expect(mainOf(home, "show", "main:memory/tech/new.md")).toContain("name: new");
});

test("publish refuses commits outside the memory folder and dreams/, a conflict marker, a binary file, or a secret, even one a later commit removes or one in a commit message, and pushes nothing", async () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ["outside", { "README.md": "# Changed\n" }, "Fleet dream: the commits change files outside memory/ and dreams/: README.md."],
    ["marker", { "memory/tech/rule.md": "<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> main\n" }, "Fleet dream: the commits add a conflict marker."],
    ["binary", { "memory/tech/blob.md": "a\0b" }, "Fleet dream: the commits add a binary file. Memory holds text only."],
    ["secret", { "memory/tech/token.md": `token ${fakeToken()}\n` }, "Fleet dream: the commits hold a secret (GitHub token), in this or an earlier commit. Remove it and rewrite the commits."],
    ["message", { "memory/tech/fine.md": note("fine") }, "Fleet dream: the commits hold a secret (GitHub token), in this or an earlier commit. Remove it and rewrite the commits."],
  ];
  for (const [name, files, refusal] of cases) {
    const { home, worktree, io } = dreamWorktree();
    const before = mainOf(home, "rev-parse", "main");
    commit(worktree, name === "message" ? `Change: ${fakeToken()}` : `Change: ${name}`, files);
    if (name === "secret") commit(worktree, "Remove the token", { "memory/tech/token.md": "no token\n" });
    const { io: dream, said } = io();

    expect([name, await dreamCommand(["publish", worktree], dream)]).toEqual([name, 1]);

    expect(said).toEqual([refusal]);
    expect(mainOf(home, "rev-parse", "main")).toBe(before);
  }
});

test("publish in the flat layout lets the Dream change any file", async () => {
  const { home, worktree, io } = dreamWorktree("");
  commit(worktree, "Update: readme", { "README.md": "# Changed\n" });
  const { io: dream } = io();

  expect(await dreamCommand(["publish", worktree], dream)).toBe(0);

  expect(mainOf(home, "show", "main:README.md")).toBe("# Changed");
});

test("publish stops on a rebase conflict, names the file, and leaves the worktree on its branch", async () => {
  const { home, laptop, worktree, io } = dreamWorktree();
  commit(worktree, "Update: rule", { "memory/tech/rule.md": note("rule", {}, "Dream's version.") });
  commit(laptop, "memory: laptop", { "memory/tech/rule.md": note("rule", {}, "Laptop's version.") });
  git(laptop, "push", "-q", "origin", "HEAD:main");
  const { io: dream, said } = io();

  expect(await dreamCommand(["publish", worktree], dream)).toBe(1);

  expect(said).toEqual(["Fleet dream: rebasing onto main conflicts in memory/tech/rule.md. Merge origin/main, keep both sides, and publish again."]);
  expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("dream/2026-11-05");
  expect(readFileSync(join(worktree, "memory/tech/rule.md"), "utf8")).toContain("Dream's version.");
  expect(mainOf(home, "show", "main:memory/tech/rule.md")).toContain("Laptop's version.");
});

test("publish refuses uncommitted changes, and says when there is nothing to publish", async () => {
  const { worktree, io } = dreamWorktree();
  const first = io();
  expect(await dreamCommand(["publish", worktree], first.io)).toBe(0);
  expect(first.printed).toEqual(["Fleet dream: nothing to publish."]);
  writeHome(worktree, { "memory/tech/draft.md": "draft\n" });
  const second = io();

  expect(await dreamCommand(["publish", worktree], second.io)).toBe(1);

  expect(second.said).toEqual(["Fleet dream: the worktree has uncommitted changes. Commit each change first."]);
  expect(existsSync(join(worktree, "memory/tech/draft.md"))).toBe(true);
});

test("publish with no worktree prints its usage and exits 2", async () => {
  const { io } = dreamWorktree();
  const { io: dream, said } = io();

  expect(await dreamCommand(["publish"], dream)).toBe(2);

  expect(said).toEqual(["Usage: fleet dream publish <worktree>"]);
});

test("publish refuses what the final tree hides from a commit-by-commit check: a merge that drops main's outside change, a padded name, a secret in a name, a symlink, and a submodule", async () => {
  const cases: Array<[string, (worktree: string, laptop: string) => void, string]> = [
    ["ours", (worktree, laptop) => {
      commit(worktree, "Update: rule", { "memory/tech/rule.md": note("rule", {}, "Dream's version.") });
      commit(laptop, "Docs: readme", { "README.md": "# Notes, by the laptop\n" });
      git(laptop, "push", "-q", "origin", "HEAD:main");
      git(worktree, "fetch", "-q", "origin", "main");
      git(worktree, "-c", "commit.gpgsign=false", "merge", "-q", "-s", "ours", "--no-edit", "origin/main");
    }, "Fleet dream: the commits change files outside memory/ and dreams/: README.md."],
    ["padded", (worktree) => commit(worktree, "Change: padded", { " memory/leak.md": "leak\n" }), "Fleet dream: the commits change files outside memory/ and dreams/:  memory/leak.md."],
    ["named", (worktree) => commit(worktree, "Change: named", { [`memory/${fakeToken()}.md`]: "harmless\n" }), "Fleet dream: the commits hold a secret (GitHub token), in this or an earlier commit. Remove it and rewrite the commits."],
    ["symlink", (worktree) => {
      rmSync(join(worktree, "memory/MEMORY.md"));
      symlinkSync("../README.md", join(worktree, "memory/MEMORY.md"));
      commit(worktree, "Change: symlink", {});
    }, "Fleet dream: the commits add a symlink or a submodule: memory/MEMORY.md. Memory holds plain files only."],
    ["submodule", (worktree) => {
      git(worktree, "update-index", "--add", "--cacheinfo", `160000,${git(worktree, "rev-parse", "HEAD")},memory/vendor`);
      git(worktree, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Change: submodule");
      mkdirSync(join(worktree, "memory/vendor"));
    }, "Fleet dream: the commits add a symlink or a submodule: memory/vendor. Memory holds plain files only."],
  ];
  for (const [name, change, refusal] of cases) {
    const { home, laptop, worktree, io } = dreamWorktree();
    change(worktree, laptop);
    const before = mainOf(home, "rev-parse", "main");
    const { io: dream, said } = io();

    expect([name, await dreamCommand(["publish", worktree], dream)]).toEqual([name, 1]);

    expect([name, said]).toEqual([name, [refusal]]);
    expect(mainOf(home, "rev-parse", "main")).toBe(before);
  }
});

test("publish refuses when a guard's Git command fails, and pushes nothing", async () => {
  const { home, worktree, io } = dreamWorktree();
  commit(worktree, "Change: outside", { "README.md": "# Changed\n" });
  const before = mainOf(home, "rev-parse", "main");
  const { io: dream, said } = io();
  const failingLog = async (args: string[]) => (args.includes("log") || args.includes("diff") ? { code: 128, stdout: "", stderr: "broken" } : realGit(args));

  expect(await dreamCommand(["publish", worktree], { ...dream, git: failingLog })).toBe(1);

  expect(said[0]).toStartWith("Fleet dream: cannot check the outgoing commits: git ");
  expect(mainOf(home, "rev-parse", "main")).toBe(before);
});

test("publish refuses a worktree paused in a rebase, and leaves it paused", async () => {
  const { home, worktree, io } = dreamWorktree();
  commit(worktree, "Change: one", { "memory/tech/one.md": note("one") });
  commit(worktree, "Change: two", { "memory/tech/two.md": note("two") });
  const paused = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "rebase", "-q", "-i", "HEAD~2"], { cwd: worktree, env: { ...gitEnv, GIT_SEQUENCE_EDITOR: "sed -i -e 1s/^pick/edit/" } });
  expect(paused.exitCode).toBe(0);
  const before = mainOf(home, "rev-parse", "main");
  const { io: dream, said } = io();

  expect(await dreamCommand(["publish", worktree], dream)).toBe(1);

  expect(said).toEqual(["Fleet dream: the worktree is in the middle of a rebase, merge, cherry-pick or revert. Finish or abort it, then publish again."]);
  expect(mainOf(home, "rev-parse", "main")).toBe(before);
});

test("publish refuses a checkout that is not the memory repo's, and pushes nothing", async () => {
  const { home, io } = dreamWorktree("");
  const other = join(home, "other.git");
  const project = join(home, "dev/project");
  git(home, "init", "-q", "--bare", "-b", "main", other);
  git(home, "clone", "-q", other, project);
  commit(project, "Start", { "README.md": "# Project\n" });
  git(project, "push", "-q", "origin", "HEAD:main");
  commit(project, "Change: project", { "src.md": "code\n" });
  const { io: dream, said } = io();

  expect(await dreamCommand(["publish", project], dream)).toBe(1);

  expect(said).toEqual([`Fleet dream: ${project} is not a worktree of the memory checkout ${join(home, ".agents/memory")}.`]);
  expect(git(home, "--git-dir", other, "log", "--format=%s", "main")).toBe("Start");
});

test("publish refuses an outside file or a symlink that only an earlier outgoing commit or merge holds", async () => {
  const cases: Array<[string, (worktree: string, laptop: string) => void, string]> = [
    ["outside", (worktree) => {
      commit(worktree, "Change: readme", { "README.md": "# Private text\n" });
      commit(worktree, "Change: restore", { "README.md": "# Notes\n", "memory/tech/new.md": note("new") });
    }, "Fleet dream: the commits change files outside memory/ and dreams/: README.md."],
    ["symlink", (worktree) => {
      symlinkSync("../../README.md", join(worktree, "memory/tech/link.md"));
      commit(worktree, "Change: link", {});
      rmSync(join(worktree, "memory/tech/link.md"));
      commit(worktree, "Change: text", { "memory/tech/link.md": note("link") });
    }, "Fleet dream: the commits add a symlink or a submodule: memory/tech/link.md. Memory holds plain files only."],
    ["merge", (worktree, laptop) => {
      commit(worktree, "Change: rule", { "memory/tech/rule.md": note("rule", {}, "Dream's version.") });
      commit(laptop, "memory: laptop", { "memory/tech/other.md": note("other") });
      git(laptop, "push", "-q", "origin", "HEAD:main");
      git(worktree, "fetch", "-q", "origin", "main");
      git(worktree, "-c", "commit.gpgsign=false", "merge", "-q", "--no-commit", "origin/main");
      symlinkSync("../../README.md", join(worktree, "memory/tech/link.md"));
      git(worktree, "add", "-A");
      git(worktree, "-c", "commit.gpgsign=false", "commit", "-q", "--no-edit");
      rmSync(join(worktree, "memory/tech/link.md"));
      commit(worktree, "Change: text", { "memory/tech/link.md": note("link") });
    }, "Fleet dream: the commits add a symlink or a submodule: memory/tech/link.md. Memory holds plain files only."],
  ];
  for (const [name, change, refusal] of cases) {
    const { home, laptop, worktree, io } = dreamWorktree();
    change(worktree, laptop);
    const before = mainOf(home, "rev-parse", "main");
    const { io: dream, said } = io();

    expect([name, await dreamCommand(["publish", worktree], dream)]).toEqual([name, 1]);

    expect([name, said]).toEqual([name, [refusal]]);
    expect(mainOf(home, "rev-parse", "main")).toBe(before);
  }
});

test("publish pushes the commit it checked, not one made in the worktree after the check", async () => {
  const { home, worktree, io } = dreamWorktree();
  commit(worktree, "Change: rule", { "memory/tech/rule.md": note("rule", {}, "Checked.") });
  const checked = git(worktree, "rev-parse", "HEAD");
  const { io: dream, printed } = io();
  const lateCommit = async (args: string[]) => {
    if (args.includes("push")) commit(worktree, "Change: late", { "memory/tech/late.md": `token ${fakeToken()}\n` });
    return realGit(args);
  };

  expect(await dreamCommand(["publish", worktree], { ...dream, git: lateCommit })).toBe(0);

  expect(mainOf(home, "rev-parse", "main")).toBe(checked);
  expect(printed).toEqual([`Fleet dream: pushed ${checked.slice(0, 7)} to main.`]);
});

test("publish accepts memory.subtree with a trailing slash, as the memory sync does", async () => {
  const { home, worktree } = dreamWorktree();
  commit(worktree, "Change: new", { "memory/tech/new.md": note("new") });
  const { io: dream } = quietIo(home, { git: realGit, env: { FLEET_SETTINGS: JSON.stringify({ ...dreamSettings, "memory.subtree": "memory/" }) } });

  expect(await dreamCommand(["publish", worktree], dream)).toBe(0);

  expect(mainOf(home, "show", "main:memory/tech/new.md")).toContain("name: new");
});

test("publish to a memory repo with no main yet says the memory sync creates it", async () => {
  const home = temp.make("fleet-dream-publish-");
  const checkout = join(home, ".agents/memory");
  git(home, "init", "-q", "--bare", "-b", "main", join(home, "origin.git"));
  git(home, "clone", "-q", join(home, "origin.git"), checkout);
  commit(checkout, "memory: hub", { "MEMORY.md": "# Memory index\n" });
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub" }) });
  const { io: dream, said } = quietIo(home, { git: realGit, env: { FLEET_SETTINGS: JSON.stringify({ ...dreamSettings, "memory.subtree": "" }) } });

  expect(await dreamCommand(["publish", checkout], dream)).toBe(1);

  expect(said).toEqual(["Fleet dream: the memory repo has no main yet. Run fleet memory-sync to create it, then publish again."]);
});
