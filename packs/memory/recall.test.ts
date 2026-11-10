import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { main } from "../../src/cli.ts";
import { git, gitEnv, tempDirs } from "../../src/testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const engineRoot = join(import.meta.dir, "../..");
const launcher = join(engineRoot, "fleet");
type Provider = "claude" | "codex";

async function fleet(args: string[], home: string) {
  const runFleetStepsOnly = async (command: string[]) => (command[1] === launcher ? fleet(command.slice(2), home) : 0);
  return main(args, { home, engineRoot, platform: "linux", env: {}, print: () => {}, run: runFleetStepsOnly });
}

async function machineWithMemory(notes: Record<string, string>) {
  const home = temp.make("home-");
  const profile = temp.make("profile-");
  const settings = { "memory.repo": "me/notes" };
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [], packs: ["memory"], plan: "both", settings, workflows: {} }));
  expect(await fleet(["apply", "--profile", profile], home)).toBe(0);
  for (const [path, text] of Object.entries(notes)) {
    mkdirSync(dirname(join(home, ".agents/memory", path)), { recursive: true });
    writeFileSync(join(home, ".agents/memory", path), text);
  }
  return home;
}

function repoCheckout(home: string, origin: string) {
  const dir = join(home, "code", "checkout");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", origin);
  return dir;
}

function installedHook(home: string, provider: Provider, event: string) {
  const config = provider === "claude" ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : parseToml(readFileSync(join(home, ".codex/config.toml"), "utf8"));
  return (config.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)[event]![0]!.hooks[0]!.command;
}

async function fire(home: string, provider: Provider, event: string, input: Record<string, unknown>) {
  const child = Bun.spawn(["sh", "-c", installedHook(home, provider, event)], {
    env: { ...gitEnv, PATH: Bun.env.PATH, HOME: home },
    stdin: new Blob([JSON.stringify({ hook_event_name: event, ...input })]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stderr, context: stdout.trim() ? (JSON.parse(stdout).hookSpecificOutput?.additionalContext as string | undefined) ?? "" : "" };
}

const shownLog = (home: string, session: string) =>
  readFileSync(join(home, ".local/state/fleet/memory/shown", `${session}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));

describe("memory recall at session start", () => {
  const notes = {
    "MEMORY.md": "# Memory index\n- [Ask before deleting](ask-before-deleting.md) — confirm a destructive step\n",
    "projects/notes-app/INDEX.md": "# notes-app\n- [Flaky sync test](flaky-sync.md) — retry once\n",
  };

  test("gives Codex the main index and the index of the repo the session works in", async () => {
    const home = await machineWithMemory(notes);
    const cwd = repoCheckout(home, "git@github.com:someone/notes-app.git");
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
    const cwd = repoCheckout(home, "git@example.org:notes-app.git");
    const { context } = await fire(home, "claude", "SessionStart", { session_id: "s1", cwd: join(cwd), source: "startup" });
    expect(context).toContain("- [Flaky sync test](flaky-sync.md)");
    expect(context).not.toContain("Ask before deleting");
  });

  test("adds nothing again when a session resumes, since it still holds what it was shown", async () => {
    const home = await machineWithMemory(notes);
    const cwd = repoCheckout(home, "https://github.com/someone/notes-app.git");
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
    const cwd = repoCheckout(home, "https://github.com/someone/notes-app.git");
    expect((await fire(home, "claude", "SessionStart", { session_id: "s1", cwd, source: "startup" })).context).toContain("Flaky sync test");
  });

  test("keeps a readable index when the other one is broken, and logs only what it showed", async () => {
    const home = await machineWithMemory({ "projects/notes-app/INDEX.md": notes["projects/notes-app/INDEX.md"] });
    mkdirSync(join(home, ".agents/memory/MEMORY.md"));
    const cwd = repoCheckout(home, "https://github.com/someone/notes-app.git");
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
