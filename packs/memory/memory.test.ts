import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AvailableSource } from "../../src/pack/types.ts";
import { git, gitEnv, tempDirs } from "../../src/testing/git.ts";
import { skillSources, devbox, engineSource, fileContent, resolveEngine } from "../../src/testing/packs.ts";
import { memoryUrl, syncMemory } from "./commands/memory-sync.ts";
import { check, indexLimit } from "./hooks/memory-cap.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const withPack = (fields = {}) =>
  resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["memory"], settings: { "memory.repo": "me/notes" }, ...fields }, devbox);
const lines = (count: number) => Array.from({ length: count }, (_, index) => `- note ${index}`).join("\n") + "\n";
const fakeToken = () => "ghp_" + "a1B2c3D4e5".repeat(4).slice(0, 36);

describe("the Memory pack", () => {
  test("asks for the memory repo at setup", () => {
    expect(withPack({ settings: {} }).unanswered.map((setting) => setting.key)).toEqual(["memory.repo"]);
  });

  test("points Claude's auto memory at the checkout, caps its index, and syncs every five minutes", () => {
    const result = withPack();
    expect(result.config).toContainEqual(expect.objectContaining({ provider: "claude", key: "autoMemoryDirectory", value: "~/.agents/memory" }));
    expect(result.files.map((file) => file.target)).toContain(".config/fleet/hooks/PreToolUse/memory-cap.ts");
    expect(result.jobs).toContainEqual(expect.objectContaining({ id: "memory-sync", command: ["fleet", "memory-sync"], schedule: { every: "5m" } }));
    expect(fileContent(result, ".agents/guides/memory.md")).toContain("`~/.agents/memory`");
    expect(Object.keys(result.commands)).toContain("memory-sync");
  });

  test("leaves the Claude parts out for a Codex-only plan", () => {
    const result = withPack({ plan: "codex" });
    expect(result.config.some((entry) => entry.key === "autoMemoryDirectory")).toBe(false);
    expect(result.files.some((file) => file.target.endsWith("memory-cap.ts"))).toBe(false);
    expect(result.jobs.map((job) => job.id)).toContain("memory-sync");
  });

  test("reads the memory repo from the settings fleet passes", async () => {
    await expect(syncMemory({ FLEET_SETTINGS: JSON.stringify({ "memory.repo": "" }) })).rejects.toThrow("Set it with fleet set memory.repo=<owner>/<repo>.");
    await expect(syncMemory({})).rejects.toThrow("run this command as fleet <command>");
  });

  test("turns a repo name into a GitHub URL and keeps a full URL", () => {
    expect(memoryUrl("me/notes")).toBe("https://github.com/me/notes.git");
    expect(memoryUrl("git@example.com:me/notes.git")).toBe("git@example.com:me/notes.git");
  });
});

describe("the memory cap hook", () => {
  test("blocks a write that makes MEMORY.md longer than the limit", () => {
    const reason = check({ tool_name: "Write", tool_input: { file_path: "/m/MEMORY.md", content: lines(indexLimit + 1) } });
    expect(reason).toContain(`would have ${indexLimit + 1} lines`);
    expect(check({ tool_name: "Write", tool_input: { file_path: "/m/MEMORY.md", content: lines(indexLimit) } })).toBeUndefined();
    expect(check({ tool_name: "Write", tool_input: { file_path: "/m/notes.md", content: lines(500) } })).toBeUndefined();
  });

  test("counts the lines an edit leaves", () => {
    const path = join(temp.make("memory-"), "MEMORY.md");
    writeFileSync(path, lines(indexLimit - 1));
    expect(check({ tool_name: "Edit", tool_input: { file_path: path, old_string: "- note 0\n", new_string: "- note 0\n- new\n" } })).toBeUndefined();
    expect(check({ tool_name: "Edit", tool_input: { file_path: path, old_string: "- note 0\n", new_string: "- note 0\n- a\n- b\n" } })).toContain(`would have ${indexLimit + 1} lines`);
  });

  test("exits 2 with the reason through Bun", async () => {
    const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/m/MEMORY.md", content: lines(indexLimit + 5) } });
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "hooks/memory-cap.ts"), "claude"], { stdin: new Blob([input]), stderr: "pipe" });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain("Fold related notes into topic files");
  });
});

describe("the memory sync", () => {
  const syncTemp = tempDirs();
  afterAll(() => syncTemp.cleanup());

  function seed(root: string, remote: string, branch = "main") {
    const dir = join(root, `seed-${branch}`);
    git(root, "clone", "-q", remote, dir);
    git(dir, "checkout", "-q", "-b", branch);
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "seed");
    git(dir, "push", "-q", "origin", branch);
  }

  let template: { empty: string; seeded: string };
  beforeAll(() => {
    const empty = syncTemp.make("memory-empty-");
    git(empty, "init", "-q", "--bare", "-b", "main", join(empty, "remote.git"));
    const seeded = syncTemp.make("memory-seeded-");
    cpSync(empty, seeded, { recursive: true });
    seed(seeded, join(seeded, "remote.git"));
    template = { empty, seeded };
  });

  function setup(seeded = true) {
    const root = syncTemp.make("memory-sync-");
    cpSync(seeded ? template.seeded : template.empty, root, { recursive: true });
    const remote = join(root, "remote.git");
    if (seeded) git(join(root, "seed-main"), "remote", "set-url", "origin", remote);
    return { root, remote };
  }

  async function sync(root: string, remote: string, machine: string, env: Record<string, string> = {}) {
    const home = join(root, `home-${machine}`);
    mkdirSync(home, { recursive: true });
    const child = Bun.spawn(["sh", join(import.meta.dir, "sync/sync.sh")], {
      env: { ...gitEnv, HOME: home, FLEET_MEMORY_URL: remote, CODER_WORKSPACE_NAME: machine, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out: out + err, checkout: join(home, ".agents/memory") };
  }

  function commitAll(dir: string, message: string, files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
    git(dir, "push", "-q", "origin", "main");
  }

  function write(dir: string, files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }

  const remoteHistory = (root: string, remote: string) => git(root, "--git-dir", remote, "log", "-p", "--all");

  test.concurrent("checks out the repo, then shares each machine's notes and merges MEMORY.md by union", async () => {
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

  test.concurrent("takes back a commit that holds a secret, so removing the secret never pushes it in the history", async () => {
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

  test.concurrent("finds a secret inside a binary file", async () => {
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

  test.concurrent("keeps the files agents wrote, resolved, or deleted after a sync stopped in the middle of a rebase", async () => {
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

  test.concurrent("puts a file still in conflict back to this machine's version, and keeps the copy from the crash", async () => {
    const { root, remote, checkout } = await crashMidRebase();
    const result = await sync(root, remote, "laptop");
    expect([result.code, result.out]).toEqual([0, expect.stringContaining("the copies from the crash are in")]);
    expect(readFileSync(join(checkout, "notes.md"), "utf8")).toBe("laptop version\n");
    expect(readFileSync(join(checkout, "later.md"), "utf8")).toBe("written after the crash\n");
    expect(existsSync(join(checkout, ".git/fleet-sync-files.tar"))).toBe(true);
  });

  test.concurrent("takes over a lock that a stopped sync left behind", async () => {
    const { root, remote } = setup();
    const laptop = await sync(root, remote, "laptop");
    const stopped = Bun.spawnSync(["true"]).pid;
    mkdirSync(`${laptop.checkout}.sync-lock`);
    writeFileSync(`${laptop.checkout}.sync-lock/pid`, `${stopped}\n`);
    writeFileSync(join(laptop.checkout, "note.md"), "a note\n");
    expect((await sync(root, remote, "laptop")).code).toBe(0);
    expect(existsSync(`${laptop.checkout}.sync-lock`)).toBe(false);
  });

  test.concurrent("keeps notes an agent wrote before the first sync, and merges their MEMORY.md", async () => {
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

  test.concurrent("starts main in an empty repo", async () => {
    const { root, remote } = setup(false);
    const laptop = await sync(root, remote, "laptop");
    expect([laptop.code, laptop.out]).toEqual([0, expect.stringContaining("is empty, and this machine has nothing to share yet")]);
    writeFileSync(join(laptop.checkout, "MEMORY.md"), "# Memory\n- first note\n");
    expect((await sync(root, remote, "laptop")).code).toBe(0);
    expect(readFileSync(join((await sync(root, remote, "box")).checkout, "MEMORY.md"), "utf8")).toContain("- first note");
  });

  test.concurrent("refuses to sync with a repo other than the one in memory.repo", async () => {
    const { root, remote } = setup();
    await sync(root, remote, "laptop");
    const other = join(root, "other.git");
    git(root, "init", "-q", "--bare", "-b", "main", other);
    const result = await sync(root, other, "laptop");
    expect([result.code, result.out]).toEqual([1, expect.stringContaining("but memory.repo is")]);
  });

  test.concurrent.each([["untracked", false], ["ignored", true]])("keeps an %s note written while it set up a new checkout", async (_, ignored) => {
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

  test.concurrent("pushes to the repo in memory.repo, whatever push URL the checkout has", async () => {
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

  test.concurrent("refuses a repo whose notes live on a branch other than main", async () => {
    const { root, remote } = setup(false);
    seed(root, remote, "master");
    const result = await sync(root, remote, "laptop");
    expect([result.code, result.out]).toEqual([1, expect.stringContaining("has no main branch")]);
  });

  test.concurrent("refuses to commit conflict markers", async () => {
    const { root, remote } = setup();
    const laptop = await sync(root, remote, "laptop");
    writeFileSync(join(laptop.checkout, "MEMORY.md"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n");
    const result = await sync(root, remote, "laptop");
    expect(result.code).toBe(1);
    expect(result.out).toContain("conflict markers");
  });
  test.concurrent.each([["the flat layout", ""], ["a memory/ subtree", "memory"]])("in %s, keeps every index line and both sides of a conflict when two machines change the same notes", async (_, subtree) => {
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

  test.concurrent("with a subtree, keeps the checkout beside the memory, links the memory to the subtree, and shares only the subtree", async () => {
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

  test.concurrent("with a subtree, moves notes an agent wrote before the first sync into the subtree", async () => {
    const { root, remote } = setup();
    commitAll(join(root, "seed-main"), "old layout", { "memory/MEMORY.md": "# Memory\n" });
    write(join(root, "home-laptop/.agents/memory"), { "early.md": "an early note\n" });
    const env = { FLEET_MEMORY_SUBTREE: "memory" };
    expect((await sync(root, remote, "laptop", env)).code).toBe(0);
    expect((await sync(root, remote, "laptop", env)).code).toBe(0);
    expect(git(root, "--git-dir", remote, "show", "main:memory/early.md")).toBe("an early note");
  });

  test.concurrent("with a subtree, pushes nothing while a change outside it waits, committed or not", async () => {
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

  test.concurrent("refuses to turn a flat checkout into a subtree link, or the other way round", async () => {
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
});
