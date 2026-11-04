import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  function setup(seeded = true) {
    const root = syncTemp.make("memory-sync-");
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    if (!seeded) return { root, remote };
    const seed = join(root, "seed");
    git(root, "clone", "-q", remote, seed);
    git(seed, "checkout", "-q", "-b", "main");
    writeFileSync(join(seed, "MEMORY.md"), "# Memory\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", "origin", "main");
    return { root, remote };
  }

  async function sync(root: string, remote: string, machine: string) {
    const home = join(root, `home-${machine}`);
    mkdirSync(home, { recursive: true });
    const child = Bun.spawn(["sh", join(import.meta.dir, "sync/sync.sh")], {
      env: { ...gitEnv, HOME: home, FLEET_MEMORY_URL: remote, CODER_WORKSPACE_NAME: machine },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out: out + err, checkout: join(home, ".agents/memory") };
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

  test.concurrent("keeps the files agents wrote after a sync stopped in the middle of a rebase", async () => {
    const { root, remote } = setup();
    const laptop = await sync(root, remote, "laptop");
    const box = await sync(root, remote, "box");
    writeFileSync(join(box.checkout, "notes.md"), "box version\n");
    expect((await sync(root, remote, "box")).code).toBe(0);
    writeFileSync(join(laptop.checkout, "notes.md"), "laptop version\n");
    git(laptop.checkout, "add", "-A");
    git(laptop.checkout, "commit", "-q", "-m", "local");
    git(laptop.checkout, "fetch", "-q", "origin", "main");
    expect(() => git(laptop.checkout, "rebase", "origin/main")).toThrow();
    const gitdir = join(laptop.checkout, ".git");
    writeFileSync(join(gitdir, "fleet-sync-rebase"), "");
    writeFileSync(join(laptop.checkout, "later.md"), "written after the crash\n");
    const result = await sync(root, remote, "laptop");
    expect([result.code, result.out]).toEqual([0, expect.stringContaining("kept every file as it was")]);
    expect(readFileSync(join(laptop.checkout, "later.md"), "utf8")).toBe("written after the crash\n");
    expect(readFileSync(join(laptop.checkout, "notes.md"), "utf8")).toBe("laptop version\n");
    expect(git(root, "--git-dir", remote, "show", "main:later.md")).toBe("written after the crash");
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

  test.concurrent("refuses to commit conflict markers", async () => {
    const { root, remote } = setup();
    const laptop = await sync(root, remote, "laptop");
    writeFileSync(join(laptop.checkout, "MEMORY.md"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n");
    const result = await sync(root, remote, "laptop");
    expect(result.code).toBe(1);
    expect(result.out).toContain("conflict markers");
  });
});
