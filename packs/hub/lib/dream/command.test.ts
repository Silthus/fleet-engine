import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../../src/testing/git.ts";
import { writeHome } from "../testing.ts";
import type { Result } from "../coder.ts";
import type { Digest } from "./digest.ts";
import type { ModelRow } from "../../../base/lib/models.ts";
import { quote } from "../machine.ts";
import { analystCommand, analystPrompt, analystTimeoutMs, modelAnalyst, render, type Analyst, type Spawn } from "./analyze.ts";
import { dreamCommand, dreamPeers, type DreamIo } from "./command.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const now = Date.parse("2026-11-05T04:10:00Z");
const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
const settings = { "hub.alias": "my-hub", "hub.dreamSessions": 150, "memory.repo": "me/notes" };

function digest(fields: Partial<Digest> = {}): Digest {
  return {
    machine: "devbox-1", provider: "claude", session: "s-1", cwd: "/home/me/dev/app", repo: "app", model: "m", startedAt: "2026-11-04T10:00:00Z",
    endedAt: "2026-11-04T11:00:00Z", toolCalls: 1, skills: [], memoryReads: [], memoryWrites: [], tokens: 10,
    entries: [{ at: "2026-11-04T10:00:00Z", role: "user", text: "Fix it" }, { at: "2026-11-04T11:00:00Z", role: "assistant", text: "Fixed." }],
    ...fields,
  };
}
const line = (item: Digest) => `${JSON.stringify(item)}\n`;

function hubHome() {
  const home = temp.make("fleet-dream-");
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub" }), ".agents/memory/MEMORY.md": "# Memory index\n" });
  return home;
}

function io(home: string, fields: Partial<DreamIo> = {}) {
  const printed: string[] = [];
  const said: string[] = [];
  const peerCalls: string[] = [];
  const launched: Array<{ title: string; prompt: string }> = [];
  const analyzed: string[] = [];
  const analyst: Analyst = async (item) => (analyzed.push(item.session), { taskType: "fix", findings: [{ kind: "correction", topic: "run-tests-first", scope: "app", reach: "general", claim: "Run the tests first.", evidence: "run the tests", memory: "", importance: 3 }] });
  const value: DreamIo = {
    home,
    env: { FLEET_SETTINGS: JSON.stringify(settings) },
    self: "hub-host",
    now: () => now,
    print: (text) => printed.push(text),
    say: (text) => said.push(text),
    peers: () => ["devbox-1", "devbox-2"],
    onPeer: async (alias, command) => (peerCalls.push(`${alias}: ${command}`), alias === "devbox-1" ? ok(line(digest())) : { code: 255, stdout: "", stderr: "ssh: connect timed out" }),
    boxes: () => undefined,
    git: async () => ok(),
    analyst: () => analyst,
    launch: async (title, prompt) => (launched.push({ title, prompt }), "thread-1"),
    ...fields,
  };
  return { io: value, printed, said, peerCalls, launched, analyzed };
}

test("the peers are the hub alias and the devboxes, without duplicates, without this machine, and without the hub itself on the hub", () => {
  expect(dreamPeers("my-hub", ["devbox-1", "devbox-2", "devbox-1", "my-hub", "hub-host"], "hub-host")).toEqual(["devbox-1", "devbox-2"]);
});

test("every subcommand but digest refuses with one line when the Memory pack's memory.repo is not in the settings", async () => {
  for (const command of ["collect", "analyze", "prepare", "budget", "scorecard", "run"]) {
    const { io: dream, printed, said } = io(hubHome(), { env: { FLEET_SETTINGS: JSON.stringify({ "hub.alias": "my-hub" }) } });
    expect([command, await dreamCommand([command], dream)]).toEqual([command, 1]);
    expect([...printed, ...said]).toEqual(["Dream needs the Memory pack: turn it on, then run fleet apply"]);
  }
  const { io: dream } = io(hubHome(), { env: { FLEET_SETTINGS: JSON.stringify({}) } });
  expect(await dreamCommand(["digest", "--since", "1d"], dream)).toBe(0);
});

test("collect runs only on the hub", async () => {
  const home = temp.make("fleet-dream-");
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "devbox" }) });
  await expect(dreamCommand(["collect"], io(home).io)).rejects.toThrow("runs only on the hub");
});

test("collect reads the hub, every peer over SSH with the engine launcher, and the running boxes, keeps the longest copy of a session, and names what it could not reach", async () => {
  const home = hubHome();
  writeHome(home, { ".claude/projects/-app/h-1.jsonl": JSON.stringify({ type: "user", sessionId: "h-1", cwd: join(home, "dev/app"), timestamp: "2026-11-05T03:00:00Z", message: { role: "user", content: "On the hub" } }) });
  const boxCalls: string[] = [];
  const longer = digest({ endedAt: "2026-11-04T12:00:00Z", machine: "box-a", entries: [...digest().entries, { at: "2026-11-04T12:00:00Z", role: "user", text: "More" }] });
  const { io: dream, printed, said, peerCalls } = io(home, {
    boxes: () => ({ running: async () => ["box-a", "box-b"], ssh: async (box, command) => (boxCalls.push(`${box}: ${command}`), box === "box-a" ? ok(line(longer)) : { code: 1, stdout: "", stderr: "" }) }),
  });
  expect(await dreamCommand(["collect", "--since", "3d"], dream)).toBe(0);
  const remote = `sh "$HOME/.local/share/fleet/engine/fleet" dream digest --since '2026-11-02T04:10:00.000Z'`;
  expect(peerCalls).toEqual([`devbox-1: ${remote}`, `devbox-2: ${remote}`]);
  expect(boxCalls).toEqual([`box-a: bash -lc ${quote(remote)}`, `box-b: bash -lc ${quote(remote)}`]);
  const run = join(home, ".local/state/fleet/dream/2026-11-05");
  expect(printed).toEqual([run]);
  const files = readdirSync(join(run, "digests")).sort();
  expect(files).toEqual(["box-a-claude-s-1-20261104120000.json", "hub-host-claude-h-1-20261105030000.json"]);
  expect(JSON.parse(readFileSync(join(run, "digests", files[0]!), "utf8")).entries.map((entry: { text: string }) => entry.text)).toEqual(["Fix it", "Fixed.", "More"]);
  expect(said.join("\n")).toContain("Not reached: devbox-2 (exit 255: ssh: connect timed out); box-b (exit 1)");
});

test("collect skips the boxes when the Boxes workflow is off", async () => {
  const { io: dream, said } = io(hubHome());
  expect(await dreamCommand(["collect"], dream)).toBe(0);
  expect(said.join("\n")).not.toContain("boxes");
});

test("collect leaves out what an earlier analysis already read, and drops runs older than 14 days", async () => {
  const home = hubHome();
  const state = join(home, ".local/state/fleet/dream");
  mkdirSync(join(state, "2026-10-01"), { recursive: true });
  writeFileSync(join(state, "seen.json"), JSON.stringify({ "claude:s-1": "2026-11-04T11:00:00Z" }));
  const { io: dream } = io(home);
  await dreamCommand(["collect"], dream);
  expect(readdirSync(join(state, "2026-11-05/digests"))).toEqual([]);
  expect(existsSync(join(state, "2026-10-01"))).toBe(false);
});

test("analyze asks one analyst per session, the busiest first up to hub.dreamSessions, records the analyzed ones as seen, and writes findings.md", async () => {
  const home = hubHome();
  const run = join(home, ".local/state/fleet/dream/2026-11-05");
  mkdirSync(join(run, "digests"), { recursive: true });
  const quiet = digest({ session: "quiet-1" });
  const busy = digest({ session: "busy-1", entries: [...digest().entries, { at: "2026-11-04T10:30:00Z", role: "user", text: "Again" }, { at: "2026-11-04T10:31:00Z", role: "error", text: "boom" }] });
  writeFileSync(join(run, "digests", "a.json"), JSON.stringify(quiet));
  writeFileSync(join(run, "digests", "b.json"), JSON.stringify(busy));
  const { io: dream, printed, analyzed } = io(home, { env: { FLEET_SETTINGS: JSON.stringify({ ...settings, "hub.dreamSessions": 1 }) } });
  expect(await dreamCommand(["analyze", run], dream)).toBe(0);
  expect(printed).toEqual([run]);
  expect(analyzed).toEqual(["busy-1"]);
  expect(JSON.parse(readFileSync(join(home, ".local/state/fleet/dream/seen.json"), "utf8"))).toEqual({ "claude:busy-1": "2026-11-04T11:00:00Z" });
  const report = readFileSync(join(run, "findings.md"), "utf8");
  expect(report).toContain("1 sessions analyzed from 1 machines (devbox-1).");
  expect(report).toContain("1 sessions with the fewest messages were left out by --limit.");
  expect(report).toContain("## correction (1)\n\n- (3) [app] {run-tests-first} Run the tests first.");
});

test("analyze lists an analyst that failed and does not mark its session as seen", async () => {
  const home = hubHome();
  const run = join(home, ".local/state/fleet/dream/2026-11-05");
  mkdirSync(join(run, "digests"), { recursive: true });
  writeFileSync(join(run, "digests", "a.json"), JSON.stringify(digest()));
  const { io: dream } = io(home, { analyst: () => async () => { throw new Error("analyst exited with 1"); } });
  expect(await dreamCommand(["analyze", run], dream)).toBe(1);
  expect(readFileSync(join(run, "findings.md"), "utf8")).toContain("Analysts failed on:\n- a.json: analyst exited with 1");
  expect(JSON.parse(readFileSync(join(home, ".local/state/fleet/dream/seen.json"), "utf8"))).toEqual({});
});

test("run prepares, then starts one T3 thread that follows the dream skill with the run directory, and exits 0", async () => {
  const home = hubHome();
  const { io: dream, launched, printed } = io(home);
  expect(await dreamCommand(["run"], dream)).toBe(0);
  const run = join(home, ".local/state/fleet/dream/2026-11-05");
  expect(launched).toEqual([{ title: "Dream 2026-11-05", prompt: `Follow the dream skill with the run directory ${run}.` }]);
  expect(printed.at(-1)).toBe(`Started the dream thread thread-1 for ${run}`);
});

test("run exits 1 when prepare fails, and starts no thread", async () => {
  const home = temp.make("fleet-dream-");
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "devbox" }) });
  const { io: dream, launched, said } = io(home);
  expect(await dreamCommand(["run"], dream)).toBe(1);
  expect(launched).toEqual([]);
  expect(said.at(-1)).toContain("runs only on the hub");
});

test("run exits 1 when the thread does not start", async () => {
  const { io: dream, said } = io(hubHome(), { launch: async () => { throw new Error("T3 Code is not running"); } });
  expect(await dreamCommand(["run"], dream)).toBe(1);
  expect(said.at(-1)).toBe("Fleet dream: cannot start the dream thread: T3 Code is not running");
});

test("render shortens a long session from the middle and keeps the opening and the end", () => {
  const entries = Array.from({ length: 80 }, (_, index) => ({ at: "", role: "assistant" as const, text: `${index} ${"x".repeat(790)}` }));
  const text = render(digest({ entries }));
  expect(text.length).toBeLessThanOrEqual(40_000);
  expect(text).toContain("[assistant] 0 ");
  expect(text).toContain("[assistant] 79 ");
  expect(text).toMatch(/\[… \d+ entries left out …\]/);
});

test("the analyst comes from the model table's lookup row, for Claude and for Codex, and its prompt names no one", () => {
  expect(analystPrompt).toContain("for the person who runs");
  expect(analystPrompt).not.toMatch(/\b(he|his|him)\b/);
  const claude = analystCommand({ role: "lookup", work: "", provider: "claude", model: "claude-small", effort: "medium" }, "/tmp/out");
  expect(claude.slice(0, 6)).toEqual(["claude", "-p", "--model", "claude-small", "--effort", "medium"]);
  expect(claude).toContain("--json-schema");
  const codex = analystCommand({ role: "lookup", work: "", provider: "codex", model: "gpt-small", effort: "low" }, "/tmp/out");
  expect(codex.slice(0, 7)).toEqual(["codex", "exec", "--ignore-user-config", "-m", "gpt-small", "-c", 'model_reasoning_effort="low"']);
  expect(codex).toContain("--output-schema");
});

test("budget prints the memory problems and exits 1, and exits 0 once memory is within budget", async () => {
  const home = hubHome();
  const { io: dream, printed } = io(home);
  writeHome(home, { ".agents/memory/stray.md": "no frontmatter\n" });
  expect(await dreamCommand(["budget"], dream)).toBe(1);
  expect(printed.join("\n")).toContain("stray.md: no index links it");
  writeHome(home, { ".agents/memory/MEMORY.md": "# Memory\n- [Stray](stray.md) — a note\n", ".agents/memory/stray.md": "---\nname: stray\ndescription: a note\nmetadata:\n  type: user\n---\nA fact.\n" });
  printed.length = 0;
  expect(await dreamCommand(["budget"], dream)).toBe(0);
  expect(printed).toEqual(["Memory is within budget."]);
});

test("collect refuses a --since value that is not a time, and asks no machine", async () => {
  const { io: dream, peerCalls } = io(hubHome());
  await expect(dreamCommand(["collect", "--since", "2026-11-01 $(printf dream-injected)"], dream)).rejects.toThrow("Cannot read --since");
  expect(peerCalls).toEqual([]);
});

test("collect sends an ISO --since to the peers as one quoted canonical time", async () => {
  const { io: dream, peerCalls } = io(hubHome());
  expect(await dreamCommand(["collect", "--since", "2026-11-01"], dream)).toBe(0);
  expect(peerCalls[0]).toBe(`devbox-1: sh "$HOME/.local/share/fleet/engine/fleet" dream digest --since '2026-11-01T00:00:00.000Z'`);
});

test("with Dream off, analyze, prepare, and run refuse with one line and build no analyst", async () => {
  for (const command of ["analyze", "prepare", "run"]) {
    let built = 0;
    const { io: dream, printed, said, launched } = io(hubHome(), {
      env: { FLEET_SETTINGS: JSON.stringify({ "hub.alias": "my-hub", "memory.repo": "me/notes" }) },
      analyst: () => (built++, async () => ({ findings: [] })),
    });
    expect([command, await dreamCommand([command], dream)]).toEqual([command, 1]);
    expect([...printed, ...said]).toEqual(["Dream is off: turn it on with fleet packs --workflows dream=on, then run fleet apply"]);
    expect([command, built, launched.length]).toEqual([command, 0, 0]);
  }
});

function twoDigests(home: string) {
  const run = join(home, ".local/state/fleet/dream/2026-11-05");
  writeHome(home, { ".local/state/fleet/dream/2026-11-05/digests/a.json": JSON.stringify(digest({ session: "s-a" })), ".local/state/fleet/dream/2026-11-05/digests/b.json": JSON.stringify(digest({ session: "s-b" })) });
  return run;
}

test("prepare and run exit 1 and start no thread when every analyst fails", async () => {
  for (const command of ["prepare", "run"]) {
    const home = hubHome();
    const { io: dream, said, launched, printed } = io(home, { onPeer: async () => ok(line(digest())), analyst: () => async () => { throw new Error("analyst exited with 2"); } });
    expect([command, await dreamCommand([command], dream)]).toEqual([command, 1]);
    expect(launched).toEqual([]);
    expect(printed).toEqual([]);
    expect(said.at(-1)).toContain("every analyst failed");
    expect(said.at(-1)).toContain("analyst exited with 2");
  }
});

test("run still starts the thread when some analysts fail, and names the failures", async () => {
  const home = hubHome();
  const run = twoDigests(home);
  const { io: dream, said, launched } = io(home, { onPeer: async () => ok(), analyst: () => async (item) => { if (item.session === "s-a") throw new Error("analyst exited with 1"); return { findings: [] }; } });
  expect(await dreamCommand(["run"], dream)).toBe(0);
  expect(launched.length).toBe(1);
  expect(said.join("\n")).toContain("analyzed 1 of 2 sessions, 1 failed: a.json: analyst exited with 1");
  expect(readFileSync(join(run, "findings.md"), "utf8")).toContain("- a.json: analyst exited with 1");
});

const lookup = (provider: "claude" | "codex"): ModelRow => ({ role: "lookup", work: "", provider, model: `${provider}-small`, effort: "low" });

test("the Claude analyst runs with no tools, no MCP servers, no skills, and no user settings", () => {
  const argv = analystCommand(lookup("claude"), "/tmp/out");
  expect(argv.slice(0, -1)).toEqual(["claude", "-p", "--model", "claude-small", "--effort", "low", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands", "--no-session-persistence", "--tools", "", "--system-prompt", analystPrompt, "--output-format", "json", "--json-schema"]);
});

test("the Codex analyst skips the user's config, so no MCP server of theirs loads, keeps writes refused by pinning the approvals reviewer to the user, and turns off every tool that reads files, the network, or images", () => {
  const off = ["shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "multi_agent", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
    "in_app_browser", "computer_use", "image_generation", "view_image", "code_mode_host", "hooks", "shell_snapshot", "skill_mcp_dependency_install", "tool_suggest",
    "sleep_tool", "goals", "workspace_dependencies"];
  const argv = analystCommand(lookup("codex"), "/tmp/out");
  expect(argv).toEqual(["codex", "exec", "--ignore-user-config", "-m", "codex-small", "-c", 'model_reasoning_effort="low"', "-c", 'web_search="disabled"',
    "-c", 'approvals_reviewer="user"', ...off.flatMap((feature) => ["--disable", feature]),
    "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "-C", "/tmp/out", "--output-schema", "/tmp/out/schema.json", "-o", "/tmp/out/answer.json", "-"]);
  expect(argv).not.toContain("mcp_servers={}");
});

test("every analyst runs with a ten minute limit, and one that hits it fails its session", async () => {
  expect(analystTimeoutMs).toBe(600_000);
  for (const provider of ["claude", "codex"] as const) {
    const limits: number[] = [];
    const spawn: Spawn = async (_argv, options) => (limits.push(options.timeoutMs), { code: 137, stdout: "", timedOut: true });
    const analyst = modelAnalyst(lookup(provider), hubHome(), {}, spawn);
    await expect(analyst(digest(), "# index", temp.make("fleet-dream-run-"))).rejects.toThrow("analyst stopped at its 10 minute limit");
    expect(limits).toEqual([600_000]);
  }
});
