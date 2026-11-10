import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableSource } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
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
