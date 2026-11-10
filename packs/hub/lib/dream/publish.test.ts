import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { git, tempDirs } from "../../../../src/testing/git.ts";
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

test.concurrent("publish rebases the Dream's commits onto the memory repo's newer main and pushes them", async () => {
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

test.concurrent("publish refuses commits outside the memory folder and dreams/, a conflict marker, a binary file, or a secret, even one a later commit removes or one in a commit message, and pushes nothing", async () => {
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

test.concurrent("publish in the flat layout lets the Dream change any file", async () => {
  const { home, worktree, io } = dreamWorktree("");
  commit(worktree, "Update: readme", { "README.md": "# Changed\n" });
  const { io: dream } = io();

  expect(await dreamCommand(["publish", worktree], dream)).toBe(0);

  expect(mainOf(home, "show", "main:README.md")).toBe("# Changed");
});

test.concurrent("publish stops on a rebase conflict, names the file, and leaves the worktree on its branch", async () => {
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

test.concurrent("publish refuses uncommitted changes, and says when there is nothing to publish", async () => {
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

test.concurrent("publish with no worktree prints its usage and exits 2", async () => {
  const { io } = dreamWorktree();
  const { io: dream, said } = io();

  expect(await dreamCommand(["publish"], dream)).toBe(2);

  expect(said).toEqual(["Usage: fleet dream publish <worktree>"]);
});
