import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit } from "../../src/testing/git.ts";
import { bash, fire, fleet, notes, proofTraps, recallHarness, shownLog } from "./recall-testing.ts";

isolateGit();
const { machineWithMemory, temp } = recallHarness();

describe("memory recall on a tool call", () => {
  test("shows the readable notes when another matching note breaks, and the broken one once it is fixed", async () => {
    const second = "---\ntriggers: [fleet proof]\n---\n\nSecond note.\n";
    const home = await machineWithMemory({ ...notes, "second.md": second }, "file:///nowhere/notes.git");
    await fleet(["memory-sync"], home);
    rmSync(join(home, ".agents/memory/second.md"));
    mkdirSync(join(home, ".agents/memory/second.md"));
    const broken = await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("fleet proof 12") });
    expect([broken.code, broken.context]).toEqual([0, expect.stringContaining("Pass full SHAs")]);
    expect(broken.context).not.toContain("Second note.");
    rmSync(join(home, ".agents/memory/second.md"), { recursive: true });
    writeFileSync(join(home, ".agents/memory/second.md"), second);
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("fleet proof 12") })).context).toContain("Second note.");
  });

  test("before the first sync, shows a note written since the last call", async () => {
    const home = await machineWithMemory(notes);
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("fleet proof 12") })).context).toContain("Pass full SHAs");
    writeFileSync(join(home, ".agents/memory/deploy.md"), "---\ntriggers: [deploy-gate]\n---\n\nWait for the gate.\n");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("run deploy-gate") })).context).toContain("Wait for the gate.");
  });

  test("the sync forgets what it showed in sessions idle for a week, and drops the shown-note log after 30 days", async () => {
    const home = await machineWithMemory(notes, "file:///nowhere/notes.git");
    await fire(home, "claude", "PreToolUse", { session_id: "old", cwd: home, ...bash("fleet proof 12") });
    await fire(home, "claude", "PreToolUse", { session_id: "recent", cwd: home, ...bash("fleet proof 12") });
    const claimed = join(home, ".local/state/fleet/memory/claimed");
    const shown = join(home, ".local/state/fleet/memory/shown");
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000);
    utimesSync(join(claimed, "old"), daysAgo(8), daysAgo(8));
    utimesSync(join(shown, "old.jsonl"), daysAgo(31), daysAgo(31));
    utimesSync(join(shown, "recent.jsonl"), daysAgo(29), daysAgo(29));
    await fleet(["memory-sync"], home);
    expect(readdirSync(claimed)).toEqual(["recent"]);
    expect(readdirSync(shown)).toEqual(["recent.jsonl"]);
  });

  test("shows a note once when parallel calls name its trigger at the same time", async () => {
    const home = await machineWithMemory(notes);
    const calls = await Promise.all(Array.from({ length: 6 }, () => fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("fleet proof 12") })));
    expect(calls.filter((call) => call.context.includes("Pass full SHAs"))).toHaveLength(1);
    expect(shownLog(home, "s1")).toHaveLength(1);
  });

  test("shows the notes of a repo whose memory lives in a subtree, through the same memory folder", async () => {
    const remoteDir = temp.make("remote-");
    const remote = join(remoteDir, "notes.git");
    await spawnGit(remoteDir, "init", "-q", "--bare", "-b", "main", remote);
    const old = join(remoteDir, "old-machine");
    await spawnGit(remoteDir, "clone", "-q", remote, old);
    mkdirSync(join(old, "memory"));
    writeFileSync(join(old, "memory/MEMORY.md"), "# Memory index\n");
    writeFileSync(join(old, "memory/proof-traps.md"), proofTraps);
    writeFileSync(join(old, "README.md"), "Shared memory\n");
    await spawnGit(old, "add", "-A");
    await spawnGit(old, "commit", "-q", "-m", "old layout");
    await spawnGit(old, "push", "-q", "origin", "HEAD:main");
    const home = await machineWithMemory({}, `file://${remote}`, { "memory.subtree": "memory" });
    expect(await fleet(["memory-sync"], home)).toBe(0);
    expect(realpathSync(join(home, ".agents/memory"))).toBe(realpathSync(join(home, ".agents/memory-repo/memory")));
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("fleet proof 12") })).context).toContain("Pass full SHAs");
  });

  test("lets the call through quietly when the memory checkout is broken", async () => {
    const home = await machineWithMemory({ "MEMORY.md": "# Memory index\n" });
    symlinkSync(join(home, "gone.md"), join(home, ".agents/memory/dangling.md"));
    expect(await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("fleet proof 12") })).toEqual({ code: 0, stderr: "", context: "" });
  });
});
