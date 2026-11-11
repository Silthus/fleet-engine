import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit } from "../../src/testing/git.ts";
import { fire, recallHarness, repoCheckout, shownLog } from "./recall-testing.ts";

isolateGit();
const { machineWithMemory } = recallHarness();

describe("memory recall at session start", () => {
  const notes = {
    "MEMORY.md": "# Memory index\n- [Ask before deleting](ask-before-deleting.md) — confirm a destructive step\n",
    "projects/notes-app/INDEX.md": "# notes-app\n- [Flaky sync test](flaky-sync.md) — retry once\n",
  };

  test("gives Codex the main index and the index of the repo the session works in", async () => {
    const home = await machineWithMemory(notes);
    const cwd = await repoCheckout(home, "git@github.com:someone/notes-app.git");
    const { code, context } = await fire(home, "codex", "SessionStart", { session_id: "s1", cwd, source: "startup" });
    expect(code).toBe(0);
    expect(context).toContain("- [Ask before deleting](ask-before-deleting.md)");
    expect(context).toContain("- [Flaky sync test](flaky-sync.md)");
    expect(context).toContain("~/.agents/memory/projects/notes-app/");
    expect(shownLog(home, "s1")).toEqual([
      expect.objectContaining({ event: "memoryShown", session: "s1", via: "index", note: "MEMORY.md" }),
      expect.objectContaining({ event: "memoryShown", session: "s1", via: "index", note: "projects/notes-app/INDEX.md" }),
    ]);
  });

  test("gives Claude only the repo index, since Claude loads the main index itself", async () => {
    const home = await machineWithMemory(notes);
    const cwd = await repoCheckout(home, "git@example.org:notes-app.git");
    const { context } = await fire(home, "claude", "SessionStart", { session_id: "s1", cwd: join(cwd), source: "startup" });
    expect(context).toContain("- [Flaky sync test](flaky-sync.md)");
    expect(context).not.toContain("Ask before deleting");
  });

  test("adds nothing again when a session resumes, since it still holds what it was shown", async () => {
    const home = await machineWithMemory(notes);
    const cwd = await repoCheckout(home, "https://github.com/someone/notes-app.git");
    expect((await fire(home, "codex", "SessionStart", { session_id: "s1", cwd, source: "startup" })).context).not.toBe("");
    expect(await fire(home, "codex", "SessionStart", { session_id: "s1", cwd, source: "resume" })).toEqual({ code: 0, stderr: "", context: "" });
    expect((await fire(home, "codex", "SessionStart", { session_id: "s1", cwd, source: "compact" })).context).toContain("Flaky sync test");
  });

  test("adds only the main index outside a repo, and nothing for Claude", async () => {
    const home = await machineWithMemory(notes);
    expect((await fire(home, "codex", "SessionStart", { session_id: "s1", cwd: home, source: "startup" })).context).toContain("Ask before deleting");
    expect(await fire(home, "claude", "SessionStart", { session_id: "s2", cwd: home, source: "startup" })).toEqual({ code: 0, stderr: "", context: "" });
  });

  test("gives Claude the repo index when the memory has no main index", async () => {
    const home = await machineWithMemory({ "projects/notes-app/INDEX.md": notes["projects/notes-app/INDEX.md"] });
    const cwd = await repoCheckout(home, "https://github.com/someone/notes-app.git");
    expect((await fire(home, "claude", "SessionStart", { session_id: "s1", cwd, source: "startup" })).context).toContain("Flaky sync test");
  });

  test("keeps a readable index when the other one is broken, and logs only what it showed", async () => {
    const home = await machineWithMemory({ "projects/notes-app/INDEX.md": notes["projects/notes-app/INDEX.md"] });
    mkdirSync(join(home, ".agents/memory/MEMORY.md"));
    const cwd = await repoCheckout(home, "https://github.com/someone/notes-app.git");
    const started = await fire(home, "codex", "SessionStart", { session_id: "s1", cwd, source: "startup" });
    expect([started.code, started.context]).toEqual([0, expect.stringContaining("Flaky sync test")]);
    expect(shownLog(home, "s1").map((line) => line.note)).toEqual(["projects/notes-app/INDEX.md"]);
  });

  test("lets the session start quietly when the memory checkout is missing or broken", async () => {
    const home = await machineWithMemory({});
    expect(await fire(home, "codex", "SessionStart", { session_id: "s1", cwd: home, source: "startup" })).toEqual({ code: 0, stderr: "", context: "" });
    mkdirSync(join(home, ".agents/memory/MEMORY.md"), { recursive: true });
    expect(await fire(home, "codex", "SessionStart", { session_id: "s2", cwd: home, source: "startup" })).toEqual({ code: 0, stderr: "", context: "" });
  });
});
