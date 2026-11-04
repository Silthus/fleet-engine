import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  function setup() {
    const root = temp.make("memory-sync-");
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    const seed = join(root, "seed");
    git(root, "clone", "-q", remote, seed);
    git(seed, "checkout", "-q", "-b", "main");
    writeFileSync(join(seed, "MEMORY.md"), "# Memory\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", "origin", "main");
    return { root, remote };
  }

  function sync(root: string, remote: string, machine: string) {
    const home = join(root, `home-${machine}`);
    mkdirSync(home, { recursive: true });
    const result = Bun.spawnSync(["sh", join(import.meta.dir, "sync/sync.sh")], {
      env: { ...gitEnv, HOME: home, FLEET_MEMORY_URL: remote, CODER_WORKSPACE_NAME: machine },
    });
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString(), checkout: join(home, ".agents/memory") };
  }

  test("clones, then shares each machine's notes and merges MEMORY.md by union", () => {
    const { root, remote } = setup();
    const laptop = sync(root, remote, "laptop");
    const box = sync(root, remote, "box");
    expect(laptop.out).toContain("Memory: cloned into");
    writeFileSync(join(laptop.checkout, "MEMORY.md"), "# Memory\n- laptop note\n");
    writeFileSync(join(laptop.checkout, "trap.md"), "a trap\n");
    writeFileSync(join(box.checkout, "MEMORY.md"), "# Memory\n- box note\n");
    expect(sync(root, remote, "laptop").out).toContain("Memory: pushed from laptop.");
    expect(sync(root, remote, "box").code).toBe(0);
    expect(sync(root, remote, "laptop").code).toBe(0);
    for (const checkout of [laptop.checkout, box.checkout]) {
      expect(readFileSync(join(checkout, "MEMORY.md"), "utf8")).toContain("- laptop note");
      expect(readFileSync(join(checkout, "MEMORY.md"), "utf8")).toContain("- box note");
    }
    expect(existsSync(join(box.checkout, "trap.md"))).toBe(true);
  });

  test("refuses to push a secret", () => {
    const { root, remote } = setup();
    const laptop = sync(root, remote, "laptop");
    writeFileSync(join(laptop.checkout, "token.md"), `the token is ${fakeToken()}\n`);
    const result = sync(root, remote, "laptop");
    expect(result.code).toBe(1);
    expect(result.out).toContain("outgoing memory holds a secret");
    expect(git(root, "--git-dir", remote, "log", "--oneline", "main")).not.toContain("memory: laptop");
  });

  test("refuses to commit conflict markers", () => {
    const { root, remote } = setup();
    const laptop = sync(root, remote, "laptop");
    writeFileSync(join(laptop.checkout, "MEMORY.md"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n");
    const result = sync(root, remote, "laptop");
    expect(result.code).toBe(1);
    expect(result.out).toContain("conflict markers");
  });
});
