import { afterEach, expect, test } from "bun:test";
import { diskSweep, diskSweepCommand, judgeArgv, judgeModel, runT3Cleanup, type DiskSweepOptions } from "./disk-sweep.ts";

const gigabyte = 1024 ** 3;
const servers: Array<{ stop(force: boolean): unknown }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function sweep(fields: Partial<DiskSweepOptions> = {}) {
  const logged: string[] = [];
  const printed: string[] = [];
  const judged: Array<{ prompt: string; denied: string[] }> = [];
  let free = 12 * gigabyte;
  const options: DiskSweepOptions = {
    dryRun: false, floorGigabytes: 10, free: () => free, log: (line) => logged.push(line), print: (line) => printed.push(line),
    cleanup: async () => ((free += gigabyte), { counts: { removed: 3, kept: 1, failed: 0 }, bytesFreed: gigabyte }),
    judge: async (prompt, denied) => (judged.push({ prompt, denied }), (free += 5 * gigabyte), { code: 0, stdout: "Removed two worktrees.\n", stderr: "" }),
    ...fields,
  };
  return { options, logged, printed, judged };
}

test("a sweep runs T3's storage cleanup, then the judgment pass, and prints the judge's report last", async () => {
  const run = sweep();
  expect(await diskSweep(run.options)).toBe(0);
  expect(run.logged).toEqual([
    "Sweep: 12.0G free.",
    "T3 storage cleanup: removed 3, kept 1, failed 0, freed 1.0G. 13.0G free.",
    "Judgment pass done: 18.0G free.",
  ]);
  expect(run.printed).toEqual(["Removed two worktrees."]);
  const { prompt, denied } = run.judged[0]!;
  expect(prompt).toContain("This box has 13.0G free in $HOME. Under 10G, lanes stop");
  expect(prompt).toContain(`sh "$HOME/.local/share/fleet/engine/fleet" prune --dry-run --no-fetch --min-idle-hours 1`);
  expect(prompt).toContain("~/.local/state/fleet/jobs/worktree-prune.log");
  expect(prompt).toContain("Remove everything that is safe to remove.");
  expect(denied).toContain("Bash(git *reset --hard*)");
  expect(denied).not.toContain("Bash(rm *)");
});

test("a dry run skips T3's cleanup, tells the judge to delete nothing, and denies every removal too", async () => {
  let cleaned = false;
  const run = sweep({ dryRun: true, cleanup: async () => ((cleaned = true), { counts: { removed: 0, kept: 0, failed: 0 }, bytesFreed: 0 }) });
  expect(await diskSweep(run.options)).toBe(0);
  expect(cleaned).toBe(false);
  expect(run.logged[0]).toBe("Sweep (dry run): 12.0G free.");
  expect(run.judged[0]!.prompt).toContain("This is a dry run. Delete nothing.");
  expect(run.judged[0]!.denied).toEqual(expect.arrayContaining(["Write", "Edit", "Bash(rm *)", "Bash(*mv *)", "Bash(kill *)", "Bash(t3 doctor*)"]));
});

test("a failed T3 cleanup is logged and the judge still runs; a failed judge fails the sweep with its error output as the report", async () => {
  const run = sweep({
    cleanup: async () => { throw new Error("T3 is not running on this machine"); },
    judge: async () => ({ code: 1, stdout: "", stderr: "claude: not signed in" }),
  });
  expect(await diskSweep(run.options)).toBe(1);
  expect(run.logged).toEqual(["Sweep: 12.0G free.", "T3 storage cleanup failed: T3 is not running on this machine", "Judgment pass failed: 12.0G free."]);
  expect(run.printed).toEqual(["claude: not signed in"]);
});

test("the judge takes the survey model and effort from the model table, and the old model only when the table has no Claude survey row", () => {
  const rows = (provider: string) => JSON.stringify([{ role: "survey", work: "Surveys", provider, model: provider === "claude" ? "mid-model" : "other-model", effort: "medium" }]);
  expect(judgeModel({ FLEET_MODELS: rows("claude") })).toEqual({ model: "mid-model", effort: "medium" });
  expect(judgeModel({ FLEET_MODELS: rows("codex") })).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
  expect(judgeModel({})).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
  expect(judgeArgv({ model: "mid-model", effort: "medium" }, ["Write", "Bash(kill *)"])).toEqual([
    "claude", "-p", "--model", "mid-model", "--effort", "medium", "--permission-mode", "bypassPermissions", "--no-session-persistence", "--disallowedTools", "Write", "Bash(kill *)",
  ]);
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
