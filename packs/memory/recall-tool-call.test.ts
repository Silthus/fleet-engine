import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, isolateGit, spawnGit } from "../../src/testing/git.ts";
import { type Provider, bash, fire, fleet, installedHook, notes, proofTraps, recallHarness, repoCheckout, shownLog } from "./recall-testing.ts";

isolateGit();
const { machineWithMemory, temp } = recallHarness();

describe("memory recall on a tool call", () => {
  test("shows a note when a call names its trigger, once per session and once per subagent", async () => {
    const home = await machineWithMemory(notes);
    const first = await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("fleet proof 12 --head abc") });
    expect(first.code).toBe(0);
    expect(first.context).toContain("Shared memory proof-traps.md, shown because this call names \"fleet proof\":\nPass full SHAs to fleet proof.");
    expect(first.context).not.toContain("triggers:");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("fleet proof 13") })).context).toBe("");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", agent_id: "a1", cwd: home, ...bash("fleet proof 13") })).context).toContain("Pass full SHAs");
    expect((await fire(home, "codex", "PreToolUse", { session_id: "s2", cwd: home, ...bash("gh search prs") })).context).toContain("Pass full SHAs");
    expect(shownLog(home, "s1")).toEqual([
      expect.objectContaining({ event: "memoryShown", session: "s1", via: "trigger", note: "proof-traps.md", trigger: "fleet proof" }),
      expect.objectContaining({ event: "memoryShown", session: "s1", agent: "a1", via: "trigger", note: "proof-traps.md", trigger: "fleet proof" }),
    ]);
  });

  test.each<Provider>(["claude", "codex"])("keeps a later guard's deny beside the note it shows on %s", async (provider) => {
    const home = await machineWithMemory(notes);
    const deny = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "A guard blocked this call." } };
    writeFileSync(join(home, ".config/fleet/hooks/PreToolUse/z-guard.ts"), `console.log(${JSON.stringify(JSON.stringify(deny))});\n`);
    const child = Bun.spawn(["sh", "-c", installedHook(home, provider, "PreToolUse")], {
      env: { ...gitEnv, PATH: Bun.env.PATH, HOME: home },
      stdin: new Blob([JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: home, ...bash("fleet proof 12") })]),
      stdout: "pipe",
    });
    const answer = JSON.parse(await new Response(child.stdout).text()).hookSpecificOutput;
    expect(answer).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "A guard blocked this call." });
    expect(answer.additionalContext).toContain("Pass full SHAs to fleet proof.");
  });

  test("names a trigger only as a whole word, and stays silent on calls that read the memory itself", async () => {
    const home = await machineWithMemory(notes);
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("fleet proofs") })).context).toBe("");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("subfleet proof") })).context).toBe("");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("grep -r 'fleet proof' ~/.agents/memory") })).context).toBe("");
  });

  test("shows a repo's note only in a session that works in that repo", async () => {
    const home = await machineWithMemory(notes);
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    await spawnGit(elsewhere, "init", "-q");
    await spawnGit(elsewhere, "remote", "add", "origin", "https://github.com/someone/other-app.git");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: elsewhere, ...bash("bun run sync-retry") })).context).toBe("");
    const cwd = await repoCheckout(home, "https://github.com/someone/notes-app.git");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd, ...bash("bun run sync-retry") })).context).toContain("Retry the sync test once.");
  });

  test("shows a note that another machine added once the sync brings it", async () => {
    const remoteDir = temp.make("remote-");
    const remote = join(remoteDir, "notes.git");
    await spawnGit(remoteDir, "init", "-q", "--bare", "-b", "main", remote);
    const other = join(remoteDir, "other");
    await spawnGit(remoteDir, "clone", "-q", remote, other);
    writeFileSync(join(other, "MEMORY.md"), "# Memory index\n");
    await spawnGit(other, "add", "-A");
    await spawnGit(other, "commit", "-q", "-m", "seed");
    await spawnGit(other, "push", "-q", "origin", "HEAD:main");
    const home = await machineWithMemory({}, `file://${remote}`);
    expect(await fleet(["memory-sync"], home)).toBe(0);
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("fleet proof 12") })).context).toBe("");

    writeFileSync(join(other, "proof-traps.md"), proofTraps);
    await spawnGit(other, "add", "-A");
    await spawnGit(other, "commit", "-q", "-m", "a trap");
    await spawnGit(other, "push", "-q", "origin", "HEAD:main");
    expect(await fleet(["memory-sync"], home)).toBe(0);
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("fleet proof 12") })).context).toContain("Pass full SHAs");
  });

  test("finds a trigger on any line of a command, and reads a quoted trigger that holds a comma", async () => {
    const formatTrap = "---\ntriggers: [\"git log --format=%h,%s\", 'deploy-gate', 'it''s,a trap', \"say \\\"hi,there\\\"\"]\n---\n\nUse --oneline.\n";
    const home = await machineWithMemory({ ...notes, "format-trap.md": formatTrap });
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("echo ready\nfleet proof 12") })).context).toContain("Pass full SHAs");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("git log --format=%h") })).context).toBe("");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("git log --format=%h,%s") })).context).toContain("Use --oneline.");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s2", cwd: home, ...bash("run deploy-gate") })).context).toContain("Use --oneline.");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s3", cwd: home, ...bash("echo a trap; echo there") })).context).toBe("");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s3", cwd: home, ...bash("echo it's,a trap") })).context).toContain("Use --oneline.");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s4", cwd: home, ...bash('say "hi,there"') })).context).toContain("Use --oneline.");
  });
});
