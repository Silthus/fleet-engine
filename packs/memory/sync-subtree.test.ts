import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/testing/git.ts";
import { memorySyncHarness } from "./sync-testing.ts";

const { setup, sync, commitAll, write } = memorySyncHarness();

test.each([["the flat layout", ""], ["a memory/ subtree", "memory"]])("in %s, keeps every index line and both sides of a conflict when two machines change the same notes", async (_, subtree) => {
  const { root, remote } = setup();
  const at = (path: string) => (subtree ? `${subtree}/${path}` : path);
  commitAll(join(root, "seed-main"), "notes", { [at("MEMORY.md")]: "# Memory\n", [at("projects/shop/INDEX.md")]: "# shop\n", [at("trap.md")]: "the trap\n" });
  const env = { FLEET_MEMORY_SUBTREE: subtree };
  const laptop = await sync(root, remote, "laptop", env);
  const box = await sync(root, remote, "box", env);
  write(laptop.checkout, { "MEMORY.md": "# Memory\n- laptop note\n", "projects/shop/INDEX.md": "# shop\n- laptop shop note\n", "trap.md": "the trap, as the laptop saw it\n" });
  write(box.checkout, { "MEMORY.md": "# Memory\n- box note\n", "projects/shop/INDEX.md": "# shop\n- box shop note\n", "trap.md": "the trap, as the box saw it\n" });
  expect((await sync(root, remote, "laptop", env)).code).toBe(0);
  const merged = await sync(root, remote, "box", env);
  expect([merged.code, merged.out]).toEqual([0, expect.stringContaining("kept the other side of a conflict in")]);
  expect((await sync(root, remote, "laptop", env)).code).toBe(0);
  for (const checkout of [laptop.checkout, box.checkout]) {
    expect(readFileSync(join(checkout, "MEMORY.md"), "utf8")).toBe("# Memory\n- laptop note\n- box note\n");
    expect(readFileSync(join(checkout, "projects/shop/INDEX.md"), "utf8")).toBe("# shop\n- laptop shop note\n- box shop note\n");
    expect(readFileSync(join(checkout, "trap.md"), "utf8")).toBe("the trap, as the box saw it\n");
    const kept = readdirSync(join(checkout, ".conflicts"));
    expect(kept).toEqual([expect.stringMatching(/^trap\.md\..*\.box\.lost$/)]);
    expect(readFileSync(join(checkout, ".conflicts", kept[0]!), "utf8")).toContain("the trap, as the laptop saw it\n");
  }
});

test("with a subtree, keeps the checkout beside the memory, links the memory to the subtree, and shares only the subtree", async () => {
  const { root, remote } = setup();
  commitAll(join(root, "seed-main"), "old layout", { "memory/MEMORY.md": "# Memory\n- old machine note\n", "scripts/sync.sh": "echo old machines\n" });
  const env = { FLEET_MEMORY_SUBTREE: "memory" };
  const laptop = await sync(root, remote, "laptop", env);
  expect(laptop.code).toBe(0);
  const repoCheckout = join(root, "home-laptop/.agents/memory-repo");
  expect(realpathSync(laptop.checkout)).toBe(realpathSync(join(repoCheckout, "memory")));
  expect(readFileSync(join(laptop.checkout, "MEMORY.md"), "utf8")).toContain("- old machine note");
  write(laptop.checkout, { "trap.md": "a new note\n" });
  write(repoCheckout, { "stray.md": "not memory\n" });
  expect((await sync(root, remote, "laptop", env)).code).toBe(0);
  expect(git(root, "--git-dir", remote, "show", "main:memory/trap.md")).toBe("a new note");
  expect(git(root, "--git-dir", remote, "log", "-1", "--name-only", "--format=", "main")).toBe("memory/trap.md");
  expect(git(root, "--git-dir", remote, "ls-tree", "-r", "--name-only", "main")).not.toContain("stray.md");
});

test("with a subtree, moves notes an agent wrote before the first sync into the subtree", async () => {
  const { root, remote } = setup();
  commitAll(join(root, "seed-main"), "old layout", { "memory/MEMORY.md": "# Memory\n" });
  write(join(root, "home-laptop/.agents/memory"), { "early.md": "an early note\n" });
  const env = { FLEET_MEMORY_SUBTREE: "memory" };
  expect((await sync(root, remote, "laptop", env)).code).toBe(0);
  expect((await sync(root, remote, "laptop", env)).code).toBe(0);
  expect(git(root, "--git-dir", remote, "show", "main:memory/early.md")).toBe("an early note");
});

test("with a subtree, pushes nothing while a change outside it waits, committed or not", async () => {
  const { root, remote } = setup();
  commitAll(join(root, "seed-main"), "old layout", { "memory/MEMORY.md": "# Memory\n", "scripts/sync.sh": "echo old machines\n" });
  const env = { FLEET_MEMORY_SUBTREE: "memory" };
  const laptop = await sync(root, remote, "laptop", env);
  const repoCheckout = join(root, "home-laptop/.agents/memory-repo");
  write(repoCheckout, { "scripts/sync.sh": "echo changed here\n" });
  write(laptop.checkout, { "trap.md": "a new note\n" });
  const edited = await sync(root, remote, "laptop", env);
  expect([edited.code, edited.out]).toEqual([1, expect.stringContaining("has changes outside memory/")]);
  git(repoCheckout, "commit", "-q", "-am", "an edit by hand");
  const committed = await sync(root, remote, "laptop", env);
  expect([committed.code, committed.out]).toEqual([1, expect.stringContaining("change files outside memory/: scripts/sync.sh")]);
  expect(git(root, "--git-dir", remote, "show", "main:scripts/sync.sh")).toBe("echo old machines");
});

test("with a subtree, finishes moving notes that a stopped sync set aside", async () => {
  const { root, remote } = setup();
  commitAll(join(root, "seed-main"), "old layout", { "memory/MEMORY.md": "# Memory\n" });
  write(join(root, "home-laptop/.agents/memory.premove"), { "early.md": "an early note\n" });
  const env = { FLEET_MEMORY_SUBTREE: "memory" };
  expect((await sync(root, remote, "laptop", env)).code).toBe(0);
  expect((await sync(root, remote, "laptop", env)).code).toBe(0);
  expect(git(root, "--git-dir", remote, "show", "main:memory/early.md")).toBe("an early note");
  expect(existsSync(join(root, "home-laptop/.agents/memory.premove"))).toBe(false);
});

test("with a subtree, keeps a note written through the new link over the one a stopped move set aside", async () => {
  const { root, remote } = setup();
  commitAll(join(root, "seed-main"), "old layout", { "memory/MEMORY.md": "# Memory\n" });
  const env = { FLEET_MEMORY_SUBTREE: "memory" };
  const laptop = await sync(root, remote, "laptop", env);
  write(laptop.checkout, { "note.md": "newer, written through the link\n" });
  write(join(root, "home-laptop/.agents/memory.premove"), { "note.md": "older, set aside\n", "other.md": "only set aside\n" });
  expect((await sync(root, remote, "laptop", env)).code).toBe(0);
  expect(git(root, "--git-dir", remote, "show", "main:memory/note.md")).toBe("newer, written through the link");
  expect(git(root, "--git-dir", remote, "show", "main:memory/other.md")).toBe("only set aside");
  const kept = git(root, "--git-dir", remote, "ls-tree", "--name-only", "main:memory/.conflicts");
  expect(git(root, "--git-dir", remote, "show", `main:memory/.conflicts/${kept}`)).toContain("older, set aside");
  expect(existsSync(join(root, "home-laptop/.agents/memory.premove"))).toBe(false);
});

test("with a subtree, stops and keeps the notes set aside when a folder reappears before the link", async () => {
  const { root, remote } = setup();
  commitAll(join(root, "seed-main"), "old layout", { "memory/MEMORY.md": "# Memory\n" });
  const memory = join(root, "home-laptop/.agents/memory");
  write(memory, { "early.md": "an early note\n" });
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ln"), `#!/bin/sh\nmkdir -p "${memory}"\nexec ${Bun.which("ln")} "$@"\n`, { mode: 0o755 });
  const raced = await sync(root, remote, "laptop", { FLEET_MEMORY_SUBTREE: "memory", PATH: `${bin}:${process.env.PATH}` });
  expect([raced.code, raced.out]).toEqual([1, expect.stringContaining("is a folder again")]);
  expect(readFileSync(join(`${memory}.premove`, "early.md"), "utf8")).toBe("an early note\n");
});

test("keeps the other side when a note written before the first sync replaces one in the repo", async () => {
  const { root, remote } = setup();
  commitAll(join(root, "seed-main"), "notes", { "trap.md": "the trap, as the repo has it\n" });
  write(join(root, "home-laptop/.agents/memory"), { "trap.md": "the trap, as the laptop saw it\n" });
  const merged = await sync(root, remote, "laptop");
  expect([merged.code, merged.out]).toEqual([0, expect.stringContaining("kept the other side of a conflict in trap.md")]);
  expect(git(root, "--git-dir", remote, "show", "main:trap.md")).toBe("the trap, as the laptop saw it");
  const kept = git(root, "--git-dir", remote, "ls-tree", "--name-only", "main:.conflicts");
  expect(git(root, "--git-dir", remote, "show", `main:.conflicts/${kept}`)).toContain("the trap, as the repo has it");
});

test.each(["*", ":(top)", "notes[0]", "-memory"])("refuses the subtree %s, which Git would read as a pattern or an option", async (subtree) => {
  const { root, remote } = setup();
  const result = await sync(root, remote, "laptop", { FLEET_MEMORY_SUBTREE: subtree });
  expect([result.code, result.out]).toEqual([1, expect.stringContaining("must name a folder inside the memory repo")]);
  expect(existsSync(join(root, "home-laptop/.agents"))).toBe(false);
});

test("refuses to turn a flat checkout into a subtree link, or the other way round", async () => {
  const { root, remote } = setup();
  expect((await sync(root, remote, "laptop")).code).toBe(0);
  const toSubtree = await sync(root, remote, "laptop", { FLEET_MEMORY_SUBTREE: "memory" });
  expect([toSubtree.code, toSubtree.out]).toEqual([1, expect.stringContaining("Move that folder aside")]);
  expect(existsSync(join(root, "home-laptop/.agents/memory-repo"))).toBe(false);

  const linked = join(root, "home-box/.agents");
  mkdirSync(linked, { recursive: true });
  symlinkSync(join(root, "elsewhere"), join(linked, "memory"));
  const toFlat = await sync(root, remote, "box");
  expect([toFlat.code, toFlat.out]).toEqual([1, expect.stringContaining("Remove the link")]);
});
