import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import {
  claimScript, isIdle, nightly, nightlySteps, poolOn, recycleScript, refreshPool, release, saveToken, setUpScript, spawn, sweep, unfinishedThreads, type PoolClient,
} from "./box.ts";
import { boxCommand } from "./box-command.ts";
import { give, poolFile, pooled } from "./pool.ts";
import { fakeCoder, fakeMachine, linkedHere, ok, start, stubBin, writeHome } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const launcher = 'sh "$HOME/.local/share/fleet/engine/fleet"';

function poolClient(room: boolean) {
  const calls: string[] = [];
  const client: PoolClient = {
    claim: async () => undefined,
    give: async (box) => (calls.push(`give ${box}`), room),
    drop: async (box) => void calls.push(`drop ${box}`),
  };
  return { client, calls };
}

test("release refuses a workspace that is not a box and deletes nothing", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, done } = fakeCoder();
  for (const name of ["devbox-2", "my-hub", "compute-lane", "box-"]) await expect(release(coder, machine, name)).rejects.toThrow("not a box");
  expect(done).toEqual([]);
});

test("release unlinks the box and stops its hub forward on every machine before it deletes it, through the engine launcher", async () => {
  const home = temp.make("fleet-box-");
  linkedHere(home);
  const { machine, calls } = fakeMachine(home);
  const { coder, calls: onBox, done } = fakeCoder();
  expect(await release(coder, machine, "box-lane")).toBe(0);
  expect(onBox[0]?.command).toBe(`${launcher} box threads`);
  const onPeers = `${launcher} box unlink box-lane; unlinked=$?; systemctl --user stop fleet-box-box-lane-hub.service 2>/dev/null; exit $unlinked`;
  expect(calls.filter((call) => call.startsWith("peer")).sort()).toEqual([`peer devbox-2: ${onPeers}`, `peer my-hub: ${onPeers}`]);
  expect(calls).toContain(`run ${join(home, ".local/bin/t3")} environment unlink env-1`);
  expect(calls).toContain("run systemctl --user stop fleet-box-box-lane-hub.service");
  expect(done).toEqual(["remove box-lane"]);
});

test("release still deletes the box but fails and names the machines that could not unlink it", async () => {
  const { machine, lines } = fakeMachine(temp.make("fleet-box-"), { onPeer: (alias) => ({ ...ok, code: alias === "devbox-2" ? 255 : 0 }) });
  const { coder, done } = fakeCoder();
  expect(await release(coder, machine, "box-lane")).toBe(1);
  expect(lines.join("\n")).toContain("still linked on devbox-2");
  expect(done).toEqual(["remove box-lane"]);
});

test("a reap's release spares a box that started again while the peers unlinked it", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, done } = fakeCoder();
  expect(await release(coder, machine, "box-lane", { stillDoomed: () => false })).toBe(1);
  expect(done).toEqual([]);
});

test("release keeps a box whose threads still run or wait for an answer, names them, and unlinks nothing", async () => {
  const { machine, calls, lines } = fakeMachine(temp.make("fleet-box-"));
  const { coder, done } = fakeCoder({ ssh: () => ({ ...ok, stdout: "Lane A (runs)\nLane B (waits for an answer)\n" }) });
  expect(await release(coder, machine, "box-lane")).toBe(1);
  expect(lines.join("\n")).toContain("Lane A (runs)");
  expect(lines.join("\n")).toContain("Lane B (waits for an answer)");
  expect(done).toEqual([]);
  expect(calls).toEqual([]);
});

test("release keeps a box it cannot ask about its threads: one that is stopped, gone, or does not answer", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const stopped = fakeCoder({ boxes: () => [{ name: "box-lane", status: "stopped", lastUsedAt: "2026-10-28T07:00:00Z" }] });
  const gone = fakeCoder({ boxes: () => [] });
  const silent = fakeCoder({ ssh: () => ({ code: 255, stdout: "", stderr: "connection refused" }) });
  for (const { coder, done } of [stopped, gone, silent]) {
    expect(await release(coder, machine, "box-lane")).toBe(1);
    expect(done).toEqual([]);
  }
  expect(stopped.calls).toEqual([]);
});

test("a forced release deletes a box without asking about its threads", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, calls, done } = fakeCoder({ boxes: () => [{ name: "box-lane", status: "stopped", lastUsedAt: "2026-10-28T07:00:00Z" }] });
  expect(await release(coder, machine, "box-lane", { force: true })).toBe(0);
  expect(calls).toEqual([]);
  expect(done).toEqual(["remove box-lane"]);
});

test("release calls the stopping hook before a box with no open threads leaves, and not on a forced release", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const stopping: string[] = [];
  const hooks = { stopping: (box: string) => void stopping.push(box) };
  await release(fakeCoder().coder, machine, "box-lane", { hooks });
  await release(fakeCoder().coder, machine, "box-lane", { hooks, force: true });
  expect(stopping).toEqual(["box-lane"]);
});

test("release returns a box to the pool: it stops the box and its hub forwards, keeps its links, and deletes nothing", async () => {
  const home = temp.make("fleet-box-");
  const record = linkedHere(home);
  const { machine, calls } = fakeMachine(home);
  const { coder, done } = fakeCoder();
  const { client, calls: asked } = poolClient(true);
  const giveBack = client.give;
  client.give = async (box) => {
    expect(done).toContain("stop box-lane");
    return giveBack(box);
  };
  expect(await release(coder, machine, "box-lane", { pool: client })).toBe(0);
  expect(asked).toEqual(["give box-lane"]);
  expect(done).toEqual(["stop box-lane"]);
  expect(existsSync(record)).toBe(true);
  expect(calls.filter((call) => call.includes("unlink"))).toEqual([]);
  expect(calls).toContain("run systemctl --user stop fleet-box-box-lane-hub.service");
});

test("release deletes the box and drops it from the pool when the pool is full", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, done } = fakeCoder();
  const { client, calls: asked } = poolClient(false);
  expect(await release(coder, machine, "box-lane", { pool: client })).toBe(0);
  expect(asked).toEqual(["give box-lane", "drop box-lane"]);
  expect(done).toEqual(["stop box-lane", "remove box-lane"]);
});

test("a devbox asks the hub at hub.alias about the pool through the engine launcher, and keeps the box when the hub cannot answer", async () => {
  const asked: string[] = [];
  const { machine } = fakeMachine(temp.make("fleet-box-"), {
    onPeer: (alias, command) => (asked.push(`${alias}: ${command}`), command.includes("box pool give") ? { ...ok, code: 255 } : ok),
  });
  const { coder, done } = fakeCoder();
  await expect(release(coder, machine, "box-lane", { pool: poolOn(machine) })).rejects.toThrow("stays stopped");
  expect(asked).toContain(`my-hub: ${launcher} box pool give box-lane`);
  expect(done).toEqual(["stop box-lane"]);
});

test("the hub keeps the pool in its own file, sized by hub.boxPoolSize", async () => {
  const home = temp.make("fleet-box-");
  const { machine } = fakeMachine(home, { isHub: true });
  const pool = poolOn(machine);
  for (const box of ["box-a", "box-b", "box-c", "box-d"]) expect(await pool.give(box)).toBe(true);
  expect(await pool.give("box-e")).toBe(false);
  expect(await pool.claim()).toBe("box-a");
  expect(pooled(poolFile(home))).toEqual(["box-b", "box-c", "box-d"]);
});

test("release keeps a busy box out of the pool", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, done } = fakeCoder({ ssh: () => ({ ...ok, stdout: "Lane A (runs)\n" }) });
  const { client, calls: asked } = poolClient(true);
  expect(await release(coder, machine, "box-lane", { pool: client })).toBe(1);
  expect(asked).toEqual([]);
  expect(done).toEqual([]);
});

test("unfinished threads are those with a turn that started within a day and still runs, or with a pending question or approval", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const state = new Database(":memory:");
  state.run("create table orchestration_v2_projection_threads (thread_id text, title text, deleted_at text)");
  state.run("create table orchestration_v2_projection_provider_turns (thread_id text, status text, started_at text)");
  state.run("create table orchestration_v2_projection_runtime_requests (thread_id text, status text)");
  for (const [id, title, deletedAt] of [["t1", "Running lane", null], ["t2", "Dead lane", null], ["t3", "Asking lane", null], ["t4", "Done lane", null], ["t5", "Deleted lane", "2026-10-28T10:00:00Z"]]) {
    state.run("insert into orchestration_v2_projection_threads values (?, ?, ?)", [id, title, deletedAt]);
  }
  state.run("insert into orchestration_v2_projection_provider_turns values ('t1', 'running', '2026-10-28T11:00:00Z'), ('t1', 'completed', '2026-10-28T09:00:00Z'), ('t2', 'running', '2026-10-27T11:00:00Z'), ('t4', 'completed', '2026-10-28T11:00:00Z'), ('t5', 'running', '2026-10-28T11:00:00Z')");
  state.run("insert into orchestration_v2_projection_runtime_requests values ('t3', 'pending'), ('t4', 'resolved'), ('t4', 'expired'), ('t5', 'pending')");
  expect(unfinishedThreads(state, now).sort()).toEqual(["Asking lane (waits for an answer)", "Running lane (runs)"]);
});

test("a box is idle after hub.boxIdleHours quiet hours, or after 24 while a heavy job or a turn runs", () => {
  const hours = (count: number) => count * 3_600_000;
  const now = Date.now();
  expect(isIdle(now - hours(3.9), false, 4, now)).toBe(false);
  expect(isIdle(now - hours(4), false, 4, now)).toBe(true);
  expect(isIdle(now - hours(5), false, 6, now)).toBe(false);
  expect(isIdle(now - hours(23), true, 4, now)).toBe(false);
  expect(isIdle(now - hours(24), true, 4, now)).toBe(true);
});

test("the sweep asks each running box through the engine launcher, stops idle ones, keeps busy ones up, and goes on after a Coder error", () => {
  const answers: Record<string, number> = { "box-idle": 0, "box-busy": 1, "box-old": 127, "box-flaky": 1, "box-later": 0 };
  const box = (name: string, status = "running") => ({ name, status, lastUsedAt: "2026-10-28T07:00:00Z" });
  const asked: string[] = [];
  const stopping: string[] = [];
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, done } = fakeCoder({
    boxes: () => [box("box-idle"), box("box-busy"), box("box-old"), box("box-stopped", "stopped"), box("box-flaky"), box("box-later")],
    ssh: (name, command) => (asked.push(command), { ...ok, code: answers[name]! }),
    extend: (name, duration) => {
      if (name === "box-flaky") throw new Error("coder schedule failed");
      done.push(`extend ${name} ${duration}`);
    },
  });
  expect(sweep(coder, machine, { stopping: (name) => void stopping.push(name) })).toBe(1);
  expect(done).toEqual(["stop box-idle", "extend box-busy 2h", "stop box-later"]);
  expect(stopping).toEqual(["box-idle", "box-later"]);
  expect(new Set(asked)).toEqual(new Set([`${launcher} box idle`]));
});

test("recycling clears T3 worktrees and scratch, stops the heavy slice, keeps exactly hub.boxKeepDirs in ~/dev, and removes the claim", () => {
  const home = temp.make("fleet-box-");
  writeHome(home, {
    "dev/notes/a": "", "dev/tools/b": "", "dev/project/c": "", "dev/other repo/d": "", "dev/notes-old/e": "",
    ".t3/worktrees/project/lane/f": "", ".t3/scratch/g": "", ".config/fleet/box-claim": "lane", ".config/fleet/mcphub.client.json": "{}",
  });
  const bin = stubBin(temp.make("fleet-bin-"), ["systemctl", "docker"]);
  const run = Bun.spawnSync(["sh", "-c", recycleScript(["notes", "tools"])], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
  expect(run.exitCode).toBe(0);
  expect(readdirSync(join(home, "dev")).sort()).toEqual(["notes", "tools"]);
  expect(readdirSync(join(home, ".t3/worktrees/project"))).toEqual([]);
  expect(readdirSync(join(home, ".t3/scratch"))).toEqual([]);
  expect(existsSync(join(home, ".config/fleet/box-claim"))).toBe(false);
  expect(existsSync(join(home, ".config/fleet/mcphub.client.json"))).toBe(true);
  expect(readFileSync(join(bin, "calls.log"), "utf8")).toBe("systemctl --user stop fleet-heavy.slice\n");
  Bun.spawnSync(["sh", "-c", recycleScript([])], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
  expect(readdirSync(join(home, "dev"))).toEqual([]);
});

function runOnBox(script: string, home: string, bin: string) {
  return Bun.spawnSync(["bash", "-c", script], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
}

test("setting up a box puts the handed-over Claude token into the T3 service's environment, in a drop-in only its owner reads, then restarts T3", () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/box-claude-token": "sk-test-token\n" });
  const bin = stubBin(temp.make("fleet-bin-"), ["systemctl", "curl", "sleep"]);
  expect(runOnBox(setUpScript("box-lane by devbox-1 at now"), home, bin).exitCode).toBe(0);
  const dropIn = join(home, ".config/systemd/user/t3code.service.d/claude-token.conf");
  expect(readFileSync(dropIn, "utf8")).toBe('[Service]\nEnvironment="CLAUDE_CODE_OAUTH_TOKEN=sk-test-token"\n');
  expect(statSync(dropIn).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(home, ".config/fleet/box-claim"), "utf8")).toBe("box-lane by devbox-1 at now\n");
  const log = readFileSync(join(bin, "calls.log"), "utf8");
  expect(log).toContain("systemctl --user daemon-reload\nsystemctl --user restart t3code.service\n");
  expect(log).not.toContain("sk-test-token");
});

test("claiming a pooled box restarts T3 only when the Claude token changed", () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/box-claude-token": "sk-test-token\n" });
  const bin = stubBin(temp.make("fleet-bin-"), ["systemctl", "curl", "sleep"]);
  expect(runOnBox(claimScript("lane by devbox-1 at now"), home, bin).exitCode).toBe(0);
  expect(readFileSync(join(bin, "calls.log"), "utf8")).toContain("systemctl --user restart t3code.service");
  Bun.spawnSync(["rm", join(bin, "calls.log")]);
  expect(runOnBox(claimScript("lane by devbox-1 at later"), home, bin).exitCode).toBe(0);
  expect(existsSync(join(bin, "calls.log"))).toBe(false);
  expect(readFileSync(join(home, ".config/fleet/box-claim"), "utf8")).toBe("lane by devbox-1 at later\n");
});

test("a box without a handed-over Claude token keeps T3 without a token drop-in", () => {
  const home = temp.make("fleet-box-");
  const bin = stubBin(temp.make("fleet-bin-"), ["systemctl", "curl", "sleep"]);
  expect(runOnBox(setUpScript("claim"), home, bin).exitCode).toBe(0);
  expect(existsSync(join(home, ".config/systemd/user/t3code.service.d"))).toBe(false);
});

function spawnCoder(machineFileAfter = 2) {
  let checks = 0;
  const running = ["box-lane", "box-lane-7", "box-pooled", "box-a", "box-b"].map((name) => ({ name, status: "running", lastUsedAt: "2026-10-28T07:00:00Z" }));
  return fakeCoder({
    boxes: () => running,
    ssh: (box, command, stdin) => {
      spawned.calls.push({ box, command, ...(stdin === undefined ? {} : { stdin }) });
      if (command === "test -f ~/.config/fleet/machine.json") return { ...ok, code: ++checks > machineFileAfter ? 0 : 1 };
      return { ...ok, stdout: command.includes("t3 pair") ? "pair-code\n" : "" };
    },
  });
}
let spawned = fakeCoder();

test("spawning a new box waits for fleet apply's machine file, hands over this machine's files, sets it up, and links it everywhere", async () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/box-claude-token": "sk-secret-token\n" });
  const { machine, calls, lines } = fakeMachine(home);
  spawned = spawnCoder();
  expect(await spawn(spawned.coder, machine, "Lane 7")).toBe(0);
  expect(spawned.done).toEqual(["create box-lane-7 from devbox-1 with 120 GB"]);
  const commands = spawned.calls.map((call) => call.command);
  expect(commands.filter((command) => command === "test -f ~/.config/fleet/machine.json")).toHaveLength(3);
  expect(commands.findIndex((command) => command.includes("box-claude-token"))).toBeGreaterThan(commands.lastIndexOf("test -f ~/.config/fleet/machine.json"));
  expect(spawned.calls.find((call) => call.stdin === "sk-secret-token\n")?.command).toContain("umask 077");
  expect([...commands, ...calls].join("\n")).not.toContain("sk-secret-token");
  expect(calls).toContain(`peer my-hub: ${launcher} box link box-lane-7`);
  expect(calls.some((call) => call.includes("-R' '60001:127.0.0.1:60001'"))).toBe(true);
  expect(lines.at(-1)).toBe("box-lane-7 env-box");
  expect(lines.join("\n")).not.toContain("not signed in");
});

test("a spawn without a Claude token still works and says Claude is not signed in on the box; with Codex in the plan it names Codex's sign-in", async () => {
  const { machine, lines } = fakeMachine(temp.make("fleet-box-"), { codex: true });
  spawned = spawnCoder(0);
  expect(await spawn(spawned.coder, machine, "lane")).toBe(0);
  expect(lines.join("\n")).toContain("Claude is not signed in on box-lane");
  expect(lines.join("\n")).toContain("fleet box run box-lane -- codex login --device-auth");
});

test("a spawn gives up when fleet apply never writes the machine file on the box, after a bounded wait on the injected clock", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  spawned = spawnCoder(Number.POSITIVE_INFINITY);
  await expect(spawn(spawned.coder, machine, "lane")).rejects.toThrow("did not finish fleet apply");
  expect(machine.now() - start).toBeLessThan(16 * 60_000);
});

test("a spawn claims a pooled box first, cleans it, and records who claimed it", async () => {
  const { machine, calls, lines } = fakeMachine(temp.make("fleet-box-"));
  spawned = spawnCoder(0);
  let claims = 0;
  const pool: PoolClient = { claim: async () => (claims++ === 0 ? "box-pooled" : undefined), give: async () => true, drop: async () => {} };
  expect(await spawn(spawned.coder, machine, "lane", pool)).toBe(0);
  expect(spawned.done).toEqual([]);
  const commands = spawned.calls.map((call) => call.command);
  expect(commands.some((command) => command.includes("fleet-heavy.slice"))).toBe(true);
  expect(commands.some((command) => command.includes("lane by devbox-1 at 2026-11-01"))).toBe(true);
  expect(calls.some((call) => call.startsWith("peer my-hub:") && call.includes(`${launcher} box link box-pooled`))).toBe(true);
  expect(lines.at(-1)).toBe("box-pooled env-box");
});

test("the nightly pool refresh warms each free box with hub.boxWarmCommand in a login shell, and only cleans it when no command is set", async () => {
  const home = temp.make("fleet-box-");
  const file = poolFile(home);
  for (const box of ["box-a", "box-b"]) await give(file, box, 4);
  const warmed = fakeMachine(home, { isHub: true, settings: { ...fakeMachine(home).machine.settings, warmCommand: "make warm" } });
  spawned = spawnCoder(0);
  expect(await refreshPool(spawned.coder, warmed.machine)).toBe(0);
  const refreshCommands = spawned.calls.filter((call) => call.command.startsWith("bash -lc")).map((call) => call.command);
  expect(refreshCommands).toHaveLength(2);
  for (const command of refreshCommands) expect(command).toContain("make warm");
  expect(spawned.done.filter((entry) => entry.startsWith("stop")).sort()).toEqual(["stop box-a", "stop box-b"]);
  expect(pooled(file).sort()).toEqual(["box-a", "box-b"]);
  const plain = fakeMachine(home, { isHub: true });
  spawned = spawnCoder(0);
  expect(await refreshPool(spawned.coder, plain.machine)).toBe(0);
  for (const call of spawned.calls.filter((entry) => entry.command.startsWith("bash -lc"))) {
    expect(call.command).toContain("fleet-heavy.slice");
    expect(call.command).not.toContain("make warm");
  }
});

test("the nightly job reaps, grants a Coder token to each profile devbox, refreshes the pool, and fails if any part failed", async () => {
  const { machine, lines } = fakeMachine(temp.make("fleet-box-"), { self: "my-hub", isHub: true, devboxes: ["devbox-1", "devbox-2"] });
  const steps = nightlySteps(machine, { reap: async () => 0, grant: (devbox) => (devbox === "devbox-2" ? 1 : 0), refresh: async () => 0 });
  expect(steps.map((step) => step.name)).toEqual(["reap", "grant devbox-1", "grant devbox-2", "refresh the pool"]);
  expect(await nightly(steps, machine)).toBe(1);
  expect(lines.filter((line) => line.includes("failed"))).toEqual(["grant devbox-2 failed (exit 1)"]);
  const passing = nightlySteps(machine, { reap: async () => 0, grant: () => 0, refresh: async () => { throw new Error("boom"); } });
  expect(await nightly(passing, machine)).toBe(1);
  expect(await nightly(nightlySteps(machine, { reap: async () => 0, grant: () => 0, refresh: async () => 0 }), machine)).toBe(0);
});

test("fleet box token saves the pasted token with mode 0600, and refuses an empty paste", async () => {
  const home = temp.make("fleet-box-");
  await saveToken(home, "  sk-pasted-token \n");
  const path = join(home, ".config/fleet/box-claude-token");
  expect(readFileSync(path, "utf8")).toBe("sk-pasted-token\n");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(home, ".config/fleet"))).toEqual(["box-claude-token"]);
  await expect(saveToken(home, "\n")).rejects.toThrow("claude setup-token");
});

function commandDeps(home: string, role?: string) {
  if (role) writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role }) });
  const { machine, lines } = fakeMachine(home);
  return { deps: { machine: () => machine, coder: () => fakeCoder().coder, readStdin: async () => "", hooks: {} }, lines };
}

test("on a machine that is not the hub, sweep, reap, pool, grant, and nightly refuse and say to run fleet hub here", async () => {
  const { deps } = commandDeps(temp.make("fleet-box-"), "devbox");
  for (const args of [["sweep"], ["reap"], ["pool", "list"], ["grant", "devbox-2"], ["nightly"]]) {
    await expect(boxCommand(args, deps)).rejects.toThrow("Run fleet hub here on the hub");
  }
  const hub = commandDeps(temp.make("fleet-box-"), "hub");
  expect(await boxCommand(["sweep"], hub.deps)).toBe(0);
});

test("an unknown box command prints the usage and fails", async () => {
  const { deps, lines } = commandDeps(temp.make("fleet-box-"), "hub");
  for (const args of [["launch"], ["release"], ["release", "box-lane", "--now"], ["run", "devbox-4", "--", "true"], ["run", "box-lane", "true"], ["run", "box-lane", "--"], ["spawn", "lane", "--old"], ["release", "box-lane", "--new"], ["pool", "give", "devbox-4"], ["pool", "empty"], ["token", "extra"]]) {
    expect([args.join(" "), await boxCommand(args, deps)]).toEqual([args.join(" "), 2]);
  }
  expect(lines.at(-1)).toContain("fleet box token");
});

test("fleet box token reads the token from standard input", async () => {
  const home = temp.make("fleet-box-");
  const { deps } = commandDeps(home);
  expect(await boxCommand(["token"], { ...deps, readStdin: async () => "sk-from-stdin\n" })).toBe(0);
  expect(readFileSync(join(home, ".config/fleet/box-claude-token"), "utf8")).toBe("sk-from-stdin\n");
});
