import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitEnv, tempDirs } from "../../../src/testing/git.ts";
import { diskSweep, diskSweepCommand, judgeArgv, judgeModel, removePath, runT3Cleanup, sweepGuard, type DiskSweepOptions } from "./disk-sweep.ts";

const gigabyte = 1024 ** 3;
const temp = tempDirs();
const servers: Array<{ stop(force: boolean): unknown }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  temp.cleanup();
});

const proposal = (candidates: Array<{ path: string; reason: string }>) => `Two caches hold most of the space.\n\n\`\`\`json\n${JSON.stringify({ candidates })}\n\`\`\`\n`;

function sweep(fields: Partial<DiskSweepOptions> = {}) {
  const logged: string[] = [];
  const printed: string[] = [];
  const prompts: string[] = [];
  const removed: string[] = [];
  let free = 12 * gigabyte;
  const options: DiskSweepOptions = {
    dryRun: false, floorGigabytes: 10, free: () => free, log: (line) => logged.push(line), print: (line) => printed.push(line),
    cleanup: async () => ((free += gigabyte), { counts: { removed: 3, kept: 1, failed: 0 }, bytesFreed: gigabyte }),
    judge: async (prompt) => (prompts.push(prompt), { code: 0, stdout: proposal([{ path: "/home/me/.cache/tool", reason: "a tool cache" }, { path: "/home/me/dev", reason: "big" }]), stderr: "" }),
    check: (path) => (path.endsWith("/dev") ? { refuse: "it is a folder directly under $HOME" } : { remove: path }),
    remove: (path) => { removed.push(path); free += 5 * gigabyte; },
    ...fields,
  };
  return { options, logged, printed, prompts, removed };
}

test("a sweep runs T3's storage cleanup, then the judge proposes, and the command removes only what its checks allow", async () => {
  const run = sweep();
  expect(await diskSweep(run.options)).toBe(0);
  expect(run.logged).toEqual([
    "Sweep: 12.0G free.",
    "T3 storage cleanup: removed 3, kept 1, failed 0, freed 1.0G. 13.0G free.",
    "Removed /home/me/.cache/tool: a tool cache.",
    "Refused /home/me/dev: it is a folder directly under $HOME.",
    "Judgment pass done: 18.0G free.",
  ]);
  expect(run.removed).toEqual(["/home/me/.cache/tool"]);
  expect(run.printed).toEqual(["Two caches hold most of the space."]);
  const prompt = run.prompts[0]!;
  expect(prompt).toContain("This box has 13.0G free in $HOME. Under 10G, lanes stop");
  expect(prompt).toContain("~/.local/state/fleet/jobs/worktree-prune.log");
  expect(prompt).toContain("You cannot delete anything.");
});

test("a dry run skips T3's cleanup, logs each candidate and what it would remove, and removes nothing", async () => {
  let cleaned = false;
  const run = sweep({ dryRun: true, cleanup: async () => ((cleaned = true), { counts: { removed: 0, kept: 0, failed: 0 }, bytesFreed: 0 }) });
  expect(await diskSweep(run.options)).toBe(0);
  expect(cleaned).toBe(false);
  expect(run.removed).toEqual([]);
  expect(run.logged).toEqual([
    "Sweep (dry run): 12.0G free.",
    "T3 storage cleanup skipped: T3 has no dry run.",
    "Would remove /home/me/.cache/tool: a tool cache.",
    "Refused /home/me/dev: it is a folder directly under $HOME.",
    "Judgment pass done: 12.0G free.",
  ]);
});

test("a failed T3 cleanup is logged and the judge still runs; a failed judge or one without a candidate list fails the sweep and removes nothing", async () => {
  const run = sweep({
    cleanup: async () => { throw new Error("T3 is not running on this machine"); },
    judge: async () => ({ code: 1, stdout: "", stderr: "claude: not signed in" }),
  });
  expect(await diskSweep(run.options)).toBe(1);
  expect(run.logged).toEqual(["Sweep: 12.0G free.", "T3 storage cleanup failed: T3 is not running on this machine", "Judgment pass failed: 12.0G free."]);
  expect(run.printed).toEqual(["claude: not signed in"]);
  const listless = sweep({ judge: async () => ({ code: 0, stdout: "I removed it all myself.", stderr: "" }) });
  expect(await diskSweep(listless.options)).toBe(1);
  expect(listless.removed).toEqual([]);
  expect(listless.logged.at(-1)).toBe("Judgment pass failed: the judge returned no candidate list. 13.0G free.");
});

function sandboxHome() {
  const home = realpathSync(temp.make("sweep-home-"));
  const outside = realpathSync(temp.make("sweep-outside-"));
  const at = (path: string) => join(home, path);
  const folder = (path: string) => (mkdirSync(at(path), { recursive: true }), writeFileSync(join(at(path), "blob"), "x"), at(path));
  const repo = (path: string) => {
    folder(path);
    git(at(path), "init", "-q", "-b", "main");
    writeFileSync(join(at(path), ".gitignore"), "node_modules/\n");
    git(at(path), "add", ".");
    git(at(path), "commit", "-q", "-m", "first");
    folder(`${path}/node_modules/dep`);
    return at(path);
  };
  const pushed = repo("dev/pushed");
  git(outside, "init", "-q", "--bare", "remote.git");
  git(pushed, "remote", "add", "origin", join(outside, "remote.git"));
  git(pushed, "push", "-q", "origin", "main");
  repo("dev/unpushed");
  repo("dev/dirty");
  writeFileSync(join(at("dev/dirty"), "notes.txt"), "work in progress");
  folder(".cache/tool");
  folder("mem/cache");
  folder(".config/app/Cache");
  folder("scratch/old");
  repo("scratch/old/project");
  folder(".local/share/tool");
  mkdirSync(join(outside, "data"));
  writeFileSync(join(outside, "data", "keep"), "x");
  symlinkSync(join(outside, "data"), at(".cache/link"));
  const env = { ...gitEnv, HOME: home, FLEET_MEMORY_DIR: at("mem") };
  return { home, outside, at, env };
}

test("the command refuses a candidate in a dirty or unpushed work tree, in the memory checkout or a protected folder, behind a symlink out of $HOME, or one that is or holds a repository", () => {
  const { home, at, env } = sandboxHome();
  const check = sweepGuard(home, env);
  expect(check(at("dev/dirty/node_modules"))).toEqual({ refuse: "its Git work tree has uncommitted changes or untracked files" });
  expect(check(at("dev/unpushed/node_modules"))).toEqual({ refuse: "its Git work tree has commits that no remote holds" });
  expect(check(at("mem/cache"))).toEqual({ refuse: `it is inside ${at("mem")}, which the sweep never touches` });
  expect(check(at(".config/app/Cache"))).toEqual({ refuse: `it is inside ${at(".config")}, which the sweep never touches` });
  expect(check(at(".cache/link"))).toEqual({ refuse: "it is outside $HOME" });
  expect(check(at("dev/pushed"))).toEqual({ refuse: "it is a Git work tree root" });
  expect(check(at("dev/pushed/.git/objects"))).toEqual({ refuse: "it is inside a Git directory" });
  expect(check(at("scratch/old"))).toEqual({ refuse: "it holds a Git repository" });
  expect(check(at("dev"))).toEqual({ refuse: "it is $HOME or a folder directly under it" });
  expect(check(home)).toEqual({ refuse: "it is $HOME or a folder directly under it" });
  expect(check("relative/path")).toEqual({ refuse: "it is not an absolute path" });
  expect(check(at(".cache/gone"))).toEqual({ refuse: "it does not exist" });
  expect(check("~/.cache/tool")).toEqual({ remove: at(".cache/tool") });
  expect(check(at("dev/pushed/node_modules"))).toEqual({ remove: at("dev/pushed/node_modules") });
});

const allCandidates = (at: (path: string) => string) => ["dev/dirty/node_modules", "dev/unpushed/node_modules", "mem/cache", ".cache/link", "dev/pushed", "scratch/old", ".cache/tool", ".local/share/tool"]
  .map((path) => ({ path: at(path), reason: "proposed" }));

test("on a real disk, a plain cache folder is removed and every refused candidate stays", async () => {
  const { home, outside, at, env } = sandboxHome();
  const run = sweep({ check: sweepGuard(home, env), remove: removePath, judge: async () => ({ code: 0, stdout: proposal(allCandidates(at)), stderr: "" }) });
  expect(await diskSweep(run.options)).toBe(0);
  expect([existsSync(at(".cache/tool")), existsSync(at(".local/share/tool"))]).toEqual([false, false]);
  for (const kept of ["dev/dirty/node_modules/dep/blob", "dev/unpushed/node_modules/dep/blob", "mem/cache/blob", "dev/pushed/.gitignore", "scratch/old/project/.gitignore", ".cache/link"]) expect(existsSync(at(kept))).toBe(true);
  expect(existsSync(join(outside, "data", "keep"))).toBe(true);
  expect(run.logged.filter((line) => line.startsWith("Removed"))).toEqual([`Removed ${at(".cache/tool")}: proposed.`, `Removed ${at(".local/share/tool")}: proposed.`]);
  expect(run.logged.filter((line) => line.startsWith("Refused")).length).toBe(6);
});

test("on a real disk, a dry run touches nothing", async () => {
  const { home, at, env } = sandboxHome();
  const run = sweep({ dryRun: true, check: sweepGuard(home, env), remove: removePath, judge: async () => ({ code: 0, stdout: proposal(allCandidates(at)), stderr: "" }) });
  expect(await diskSweep(run.options)).toBe(0);
  expect([existsSync(at(".cache/tool/blob")), existsSync(at(".local/share/tool/blob"))]).toEqual([true, true]);
  expect(run.logged.filter((line) => line.startsWith("Would remove"))).toEqual([`Would remove ${at(".cache/tool")}: proposed.`, `Would remove ${at(".local/share/tool")}: proposed.`]);
});

test("the judge takes the survey model and effort from the model table, and the old model only when the table has no Claude survey row", () => {
  const rows = (provider: string) => JSON.stringify([{ role: "survey", work: "Surveys", provider, model: provider === "claude" ? "mid-model" : "other-model", effort: "medium" }]);
  expect(judgeModel({ FLEET_MODELS: rows("claude") })).toEqual({ model: "mid-model", effort: "medium" });
  expect(judgeModel({ FLEET_MODELS: rows("codex") })).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
  expect(judgeModel({})).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
});

test("the judge runs without bypass, in restricted mode with no MCP servers, and with read-only tools only", () => {
  const argv = judgeArgv({ model: "mid-model", effort: "medium" });
  expect(argv.slice(0, 14)).toEqual([
    "claude", "-p", "--model", "mid-model", "--effort", "medium", "--no-session-persistence", "--restricted", "--strict-mcp-config", "--permission-mode", "dontAsk", "--tools", "Bash,Read,Glob,Grep", "--allowedTools",
  ]);
  expect(argv).not.toContain("bypassPermissions");
  const allowed = argv.slice(14, argv.indexOf("--disallowedTools"));
  expect(allowed).toEqual(["Read", "Glob", "Grep", "Bash(du *)", "Bash(ls *)", "Bash(df *)", "Bash(find *)", "Bash(git status*)", "Bash(git log*)", "Bash(git -C * status*)", "Bash(git -C * log*)"]);
  const denied = argv.slice(argv.indexOf("--disallowedTools") + 1);
  expect(denied).toEqual(expect.arrayContaining(["Bash(*find * -delete*)", "Bash(*find * -exec*)", "Bash(*find * -ok*)", "Bash(*find * -fprint*)", "Bash(*find * -fls*)", "Bash(rm *)", "Write", "Edit"]));
});

test("T3's storage cleanup runs over a session allowed to change settings, with a 20 minute limit", async () => {
  const tags: Array<[string, unknown]> = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response(null, { status: 400 })),
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw));
        if (message._tag !== "Request") return;
        tags.push([message.tag, message.payload]);
        socket.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: { counts: { removed: 1, kept: 0, failed: 0 }, bytesFreed: 2 * gigabyte } } }));
      },
    },
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  const cli: string[][] = [];
  const deadlines: string[] = [];
  const report = await runT3Cleanup({
    server: { origin, wsUrl: `${origin.replace("http:", "ws:")}/ws`, cli: { command: "t3", args: [] } },
    runCli: (_server, args) => (cli.push(args), { status: 0, stdout: JSON.stringify({ sessionId: "s", token: "t" }) }),
    deadline: (what, ms) => (deadlines.push(`${what} ${ms}`), () => {}),
  });
  expect(report).toEqual({ counts: { removed: 1, kept: 0, failed: 0 }, bytesFreed: 2 * gigabyte });
  expect(tags).toEqual([["server.runStorageCleanup", {}]]);
  expect(cli[0]).toEqual(["auth", "session", "issue", "--json", "--ttl", "25m", "--label", "fleet", "--subject", "fleet", "--scope", "orchestration:read", "--scope", "access:read", "--scope", "settings:write"]);
  expect(deadlines).toContain("server.runStorageCleanup 1200000");
});

test("fleet disk-sweep takes only --dry-run", async () => {
  await expect(diskSweepCommand(["--all"], { home: "/nowhere", env: {} })).rejects.toThrow("Usage: fleet disk-sweep [--dry-run]");
});
