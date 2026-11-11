import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/testing/git.ts";
import { fakeToken, memorySyncHarness } from "./sync-testing.ts";

const { seed, setup, sync, remoteHistory } = memorySyncHarness();

test("checks out the repo, then shares each machine's notes and merges MEMORY.md by union", async () => {
  const { root, remote } = setup();
  const laptop = await sync(root, remote, "laptop");
  const box = await sync(root, remote, "box");
  expect(laptop.out).toContain("Memory: checked out");
  writeFileSync(join(laptop.checkout, "MEMORY.md"), "# Memory\n- laptop note\n");
  writeFileSync(join(laptop.checkout, "trap.md"), "a trap\n");
  writeFileSync(join(box.checkout, "MEMORY.md"), "# Memory\n- box note\n");
  expect((await sync(root, remote, "laptop")).out).toContain("Memory: pushed from laptop.");
  expect((await sync(root, remote, "box")).code).toBe(0);
  expect((await sync(root, remote, "laptop")).code).toBe(0);
  for (const checkout of [laptop.checkout, box.checkout]) {
    expect(readFileSync(join(checkout, "MEMORY.md"), "utf8")).toContain("- laptop note");
    expect(readFileSync(join(checkout, "MEMORY.md"), "utf8")).toContain("- box note");
  }
  expect(existsSync(join(box.checkout, "trap.md"))).toBe(true);
});

test("takes back a commit that holds a secret, so removing the secret never pushes it in the history", async () => {
  const { root, remote } = setup();
  const laptop = await sync(root, remote, "laptop");
  writeFileSync(join(laptop.checkout, "token.md"), `the token is ${fakeToken()}\n`);
  const blocked = await sync(root, remote, "laptop");
  expect([blocked.code, blocked.out]).toEqual([1, expect.stringContaining("an unpushed memory change holds a secret")]);
  expect(git(laptop.checkout, "rev-list", "--count", "origin/main..HEAD").trim()).toBe("0");
  expect(readFileSync(join(laptop.checkout, "token.md"), "utf8")).toContain("ghp_");
  rmSync(join(laptop.checkout, "token.md"));
  writeFileSync(join(laptop.checkout, "clean.md"), "no secret here\n");
  expect((await sync(root, remote, "laptop")).code).toBe(0);
  expect(remoteHistory(root, remote)).toContain("no secret here");
  expect(remoteHistory(root, remote)).not.toContain("ghp_");
});

test("finds a secret inside a binary file", async () => {
  const { root, remote } = setup();
  const laptop = await sync(root, remote, "laptop");
  writeFileSync(join(laptop.checkout, "shot.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), Buffer.from(fakeToken())]));
  expect((await sync(root, remote, "laptop")).code).toBe(1);
  expect(remoteHistory(root, remote)).not.toContain("memory: laptop");
});

async function crashMidRebase() {
  const { root, remote } = setup();
  const other = join(root, "seed-main");
  writeFileSync(join(other, "kept.md"), "a tracked note\n");
  writeFileSync(join(other, "staged.md"), "another tracked note\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "kept");
  git(other, "push", "-q", "origin", "main");
  const laptop = await sync(root, remote, "laptop");
  writeFileSync(join(other, "notes.md"), "box version\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "box");
  git(other, "push", "-q", "origin", "main");
  writeFileSync(join(laptop.checkout, "notes.md"), "laptop version\n");
  git(laptop.checkout, "add", "-A");
  git(laptop.checkout, "commit", "-q", "-m", "local");
  git(laptop.checkout, "fetch", "-q", "origin", "main");
  expect(() => git(laptop.checkout, "rebase", "origin/main")).toThrow();
  writeFileSync(join(laptop.checkout, ".git/fleet-sync-rebase"), "");
  writeFileSync(join(laptop.checkout, "later.md"), "written after the crash\n");
  return { root, remote, checkout: laptop.checkout };
}

test("keeps the files agents wrote, resolved, or deleted after a sync stopped in the middle of a rebase", async () => {
  const { root, remote, checkout } = await crashMidRebase();
  writeFileSync(join(checkout, "notes.md"), "resolved by an agent\n");
  rmSync(join(checkout, "kept.md"));
  git(checkout, "rm", "-q", "staged.md");
  const result = await sync(root, remote, "laptop");
  expect([result.code, result.out]).toEqual([0, expect.stringContaining("kept every file as it was")]);
  expect(readFileSync(join(checkout, "later.md"), "utf8")).toBe("written after the crash\n");
  expect(readFileSync(join(checkout, "notes.md"), "utf8")).toBe("resolved by an agent\n");
  expect(existsSync(join(checkout, "kept.md"))).toBe(false);
  expect(git(root, "--git-dir", remote, "show", "main:notes.md")).toBe("resolved by an agent");
  expect(existsSync(join(checkout, "staged.md"))).toBe(false);
  expect(git(root, "--git-dir", remote, "ls-tree", "--name-only", "main").split("\n")).not.toEqual(expect.arrayContaining(["kept.md"]));
  expect(git(root, "--git-dir", remote, "ls-tree", "--name-only", "main").split("\n")).not.toEqual(expect.arrayContaining(["staged.md"]));
});

test("puts a file still in conflict back to this machine's version, and keeps the copy from the crash", async () => {
  const { root, remote, checkout } = await crashMidRebase();
  const result = await sync(root, remote, "laptop");
  expect([result.code, result.out]).toEqual([0, expect.stringContaining("the copies from the crash are in")]);
  expect(readFileSync(join(checkout, "notes.md"), "utf8")).toBe("laptop version\n");
  expect(readFileSync(join(checkout, "later.md"), "utf8")).toBe("written after the crash\n");
  expect(existsSync(join(checkout, ".git/fleet-sync-files.tar"))).toBe(true);
});

test("takes over a lock that a stopped sync left behind", async () => {
  const { root, remote } = setup();
  const laptop = await sync(root, remote, "laptop");
  const stopped = Bun.spawnSync(["true"]).pid;
  mkdirSync(`${laptop.checkout}.sync-lock`);
  writeFileSync(`${laptop.checkout}.sync-lock/pid`, `${stopped}\n`);
  writeFileSync(join(laptop.checkout, "note.md"), "a note\n");
  expect((await sync(root, remote, "laptop")).code).toBe(0);
  expect(existsSync(`${laptop.checkout}.sync-lock`)).toBe(false);
});

test("keeps notes an agent wrote before the first sync, and merges their MEMORY.md", async () => {
  const { root, remote } = setup();
  const early = join(root, "home-laptop/.agents/memory");
  mkdirSync(early, { recursive: true });
  writeFileSync(join(early, "MEMORY.md"), "# Memory\n- early note\n");
  writeFileSync(join(early, "early.md"), "an early note\n");
  expect((await sync(root, remote, "laptop")).code).toBe(0);
  const box = await sync(root, remote, "box");
  expect(readFileSync(join(box.checkout, "MEMORY.md"), "utf8")).toContain("- early note");
  expect(existsSync(join(box.checkout, "early.md"))).toBe(true);
});

test("starts main in an empty repo", async () => {
  const { root, remote } = setup(false);
  const laptop = await sync(root, remote, "laptop");
  expect([laptop.code, laptop.out]).toEqual([0, expect.stringContaining("is empty, and this machine has nothing to share yet")]);
  writeFileSync(join(laptop.checkout, "MEMORY.md"), "# Memory\n- first note\n");
  expect((await sync(root, remote, "laptop")).code).toBe(0);
  expect(readFileSync(join((await sync(root, remote, "box")).checkout, "MEMORY.md"), "utf8")).toContain("- first note");
});

test("refuses to sync with a repo other than the one in memory.repo", async () => {
  const { root, remote } = setup();
  await sync(root, remote, "laptop");
  const other = join(root, "other.git");
  git(root, "init", "-q", "--bare", "-b", "main", other);
  const result = await sync(root, other, "laptop");
  expect([result.code, result.out]).toEqual([1, expect.stringContaining("but memory.repo is")]);
});

test.each([["untracked", false], ["ignored", true]])("keeps an %s note written while it set up a new checkout", async (_, ignored) => {
  const { root, remote } = setup(false);
  const laptop = await sync(root, remote, "laptop");
  if (ignored) writeFileSync(join(laptop.checkout, ".git/info/exclude"), "MEMORY.md\n");
  seed(root, remote);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" fetch "*) printf -- '- written during the fetch\\n' > "${join(laptop.checkout, "MEMORY.md")}";; esac\nexec ${Bun.which("git")} "$@"\n`, { mode: 0o755 });
  const racing = await sync(root, remote, "laptop", { PATH: `${bin}:${process.env.PATH}` });
  expect([racing.code, racing.out]).toEqual([0, expect.stringContaining("files appeared while setting up")]);
  expect(readFileSync(join(laptop.checkout, "MEMORY.md"), "utf8")).toBe("- written during the fetch\n");
  if (ignored) return;
  expect((await sync(root, remote, "laptop")).code).toBe(0);
  expect(git(root, "--git-dir", remote, "show", "main:MEMORY.md")).toBe("# Memory\n- written during the fetch");
});

test("pushes to the repo in memory.repo, whatever push URL the checkout has", async () => {
  const { root, remote } = setup();
  const laptop = await sync(root, remote, "laptop");
  const other = join(root, "other.git");
  git(root, "init", "-q", "--bare", "-b", "main", other);
  git(laptop.checkout, "config", "remote.origin.pushurl", other);
  writeFileSync(join(laptop.checkout, "note.md"), "a note\n");
  expect((await sync(root, remote, "laptop")).code).toBe(0);
  expect(git(root, "--git-dir", remote, "show", "main:note.md")).toBe("a note");
  expect(git(root, "--git-dir", other, "for-each-ref")).toBe("");
});

test("refuses a repo whose notes live on a branch other than main", async () => {
  const { root, remote } = setup(false);
  seed(root, remote, "master");
  const result = await sync(root, remote, "laptop");
  expect([result.code, result.out]).toEqual([1, expect.stringContaining("has no main branch")]);
});

test("refuses to commit conflict markers", async () => {
  const { root, remote } = setup();
  const laptop = await sync(root, remote, "laptop");
  writeFileSync(join(laptop.checkout, "MEMORY.md"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n");
  const result = await sync(root, remote, "laptop");
  expect(result.code).toBe(1);
  expect(result.out).toContain("conflict markers");
});
