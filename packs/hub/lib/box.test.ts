import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { claimScript, isIdle, nightly, nightlySteps, recycleScript, refreshPool, release, saveToken, setUpScript, spawn, startBox, sweep, unfinishedThreads } from "./box.ts";
import { boxCommand, type BoxDeps } from "./box-command.ts";
import { BoxBusy, lockBox } from "./box-lock.ts";
import type { Box } from "./coder.ts";
import { link, restoreForwards } from "./links.ts";
import type { Machine } from "./machine.ts";
import { poolFile, pooled } from "./pool.ts";
import { box, fakeCoder, fakeMachine, linkedHere, ok, registryOf, start, stubBin, writeHome, writePool } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const launcher = 'sh "$HOME/.local/share/fleet/engine/fleet"';
const machineFileCheck = "test -f ~/.config/fleet/machine.json";
const noWait = { waitMs: 0 };

function hubHome() {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub" }) });
  return home;
}

const onHub = (home: string, fields: Partial<Machine> = {}) => fakeMachine(home, { self: "my-hub", isHub: true, peers: ["devbox-1", "devbox-2"], ...fields });
const answers = (claim: () => string, threads = () => "") => async (_box: string, command: string) => ({ ...ok, stdout: command.startsWith("cut ") ? `${claim()}\n` : command.includes("box threads") ? threads() : command.includes("t3 pair") ? "pair-code\n" : "" });
const depsFor = (machine: Machine, coder: BoxDeps["coder"]): BoxDeps => ({ machine: () => machine, coder, readStdin: async () => "", hooks: {} });

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
  expect(onBox.map((call) => call.command)).toEqual(["cut -d' ' -f1 ~/.config/fleet/box-claim 2>/dev/null", `${launcher} box threads`]);
  const onPeers = `${launcher} box unlink box-lane; unlinked=$?; systemctl --user stop fleet-box-box-lane-hub.service 2>/dev/null; exit $unlinked`;
  expect(calls.filter((call) => call.startsWith("peer")).sort()).toEqual([`peer devbox-2: ${onPeers}`, `peer my-hub: ${onPeers}`]);
  expect(calls).toContain(`run ${join(home, ".local/bin/t3")} environment unlink env-1`);
  expect(calls).toContain("run systemctl --user stop fleet-box-box-lane-hub.service");
  expect(done).toEqual(["remove box-lane"]);
});

test("release still deletes the box but fails and names the machines that could not unlink it", async () => {
  const { machine, lines } = fakeMachine(temp.make("fleet-box-"), { onPeer: async (alias) => ({ ...ok, code: alias === "devbox-2" ? 255 : 0 }) });
  const { coder, done } = fakeCoder();
  expect(await release(coder, machine, "box-lane")).toBe(1);
  expect(lines.join("\n")).toContain("still linked on devbox-2");
  expect(done).toEqual(["remove box-lane"]);
});

test("a reap's release spares a box that started again while the peers unlinked it", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, done } = fakeCoder();
  expect(await release(coder, machine, "box-lane", { stillDoomed: async () => false })).toBe(1);
  expect(done).toEqual([]);
});

test("release keeps a box whose threads still run or wait for an answer, names them, and unlinks nothing", async () => {
  const { machine, calls, lines } = fakeMachine(temp.make("fleet-box-"));
  const { coder, done } = fakeCoder({ ssh: async () => ({ ...ok, stdout: "Lane A (runs)\nLane B (waits for an answer)\n" }) });
  expect(await release(coder, machine, "box-lane")).toBe(1);
  expect(lines.join("\n")).toContain("Lane A (runs)");
  expect(lines.join("\n")).toContain("Lane B (waits for an answer)");
  expect(done).toEqual([]);
  expect(calls).toEqual([]);
});

test("release keeps a box it cannot ask about its threads: one that is stopped, gone, or does not answer", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const stopped = fakeCoder({}, [box("box-lane", "stopped")]);
  const gone = fakeCoder({}, []);
  const silent = fakeCoder({ ssh: async () => ({ code: 255, stdout: "", stderr: "connection refused" }) });
  for (const { coder, done } of [stopped, gone, silent]) {
    expect(await release(coder, machine, "box-lane")).toBe(1);
    expect(done).toEqual([]);
  }
  expect(stopped.calls).toEqual([]);
});

test("a forced release deletes a box without asking about its threads", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, calls, done } = fakeCoder({}, [box("box-lane", "stopped")]);
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

test("release returns a box to the pool on the hub: it marks the box as leaving, stops it by its recorded id, keeps its links, and deletes nothing", async () => {
  const home = hubHome();
  const record = linkedHere(home);
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  const { machine, calls } = onHub(home);
  const listed = [box("box-lane")];
  const fake = fakeCoder({ ssh: answers(() => "c-1") }, listed);
  const stop = fake.coder.stop;
  fake.coder.stop = async (id) => {
    expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1", leaving: "pool" });
    await stop(id);
  };
  expect(await release(fake.coder, machine, "box-lane")).toBe(0);
  expect(fake.done).toEqual(["stop box-lane"]);
  expect(pooled(poolFile(home))).toEqual(["box-lane"]);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane" });
  expect(existsSync(record)).toBe(true);
  expect(calls.filter((call) => call.includes("unlink"))).toEqual([]);
  expect(calls).toContain("run systemctl --user stop fleet-box-box-lane-hub.service");
});

test("release deletes the box when the pool is full, and forgets it only after the delete", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  const { machine } = onHub(home);
  machine.settings = { ...machine.settings, poolSize: 0 };
  const fake = fakeCoder({ ssh: answers(() => "c-1") });
  const remove = fake.coder.remove;
  fake.coder.remove = async (id) => {
    expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1", leaving: "delete" });
    await remove(id);
  };
  expect(await release(fake.coder, machine, "box-lane")).toBe(0);
  expect(fake.done).toEqual(["stop box-lane", "remove box-lane"]);
  expect(registryOf(home).boxes["box-lane"]).toBeUndefined();
});

test("on a devbox, spawn, start and release are one SSH call to the hub with the lane label and this devbox's SSH name, and never call Coder", async () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "devbox" }) });
  const { machine, toHub, calls } = fakeMachine(home);
  machine.toHub = async (args) => (toHub.push(args), args.includes("release") ? 1 : 0);
  const deps = depsFor(machine, () => {
    throw new Error("a devbox never calls Coder for a box operation");
  });
  expect(await boxCommand(["spawn", "Lane 7"], deps)).toBe(0);
  expect(await boxCommand(["spawn", "--new"], deps)).toBe(0);
  expect(await boxCommand(["start", "box-lane"], deps)).toBe(0);
  expect(await boxCommand(["release", "box-lane", "--force", "--delete"], deps)).toBe(1);
  expect(toHub).toEqual([
    ["box", "spawn", "Lane 7", "--for", "devbox-1"],
    ["box", "spawn", "--new", "--for", "devbox-1"],
    ["box", "start", "box-lane", "--for", "devbox-1"],
    ["box", "release", "box-lane", "--force", "--delete", "--for", "devbox-1"],
  ]);
  expect(calls).toEqual([]);
  expect(existsSync(poolFile(home))).toBe(false);
});

test("release keeps a busy box out of the pool: it checks the threads under the box lock and leaves the record as it was", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  const { machine } = onHub(home);
  const { coder, done } = fakeCoder({ ssh: answers(() => "c-1", () => "Lane A (runs)\n") });
  expect(await release(coder, machine, "box-lane")).toBe(1);
  expect(done).toEqual([]);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1" });
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

test("the sweep asks each running box through the engine launcher, stops idle ones by id, keeps busy ones up, and goes on after a Coder error", async () => {
  const answers: Record<string, number> = { "box-idle": 0, "box-busy": 1, "box-old": 127, "box-flaky": 1, "box-later": 0 };
  const asked: string[] = [];
  const stopping: string[] = [];
  const home = temp.make("fleet-box-");
  writePool(home, { boxes: Object.fromEntries(["box-idle", "box-busy", "box-old", "box-stopped", "box-flaky", "box-later"].map((name) => [name, { id: `ws-${name}`, claim: `c-${name}` }])) });
  const { machine } = fakeMachine(home);
  const listed = [box("box-idle"), box("box-busy"), box("box-old"), box("box-stopped", "stopped"), box("box-flaky"), box("box-later")];
  const fake = fakeCoder({ ssh: async (name, command) => (asked.push(command), { ...ok, code: answers[name]! }) }, listed);
  fake.coder.extend = async (id, deadline) => {
    if (id === "ws-box-flaky") throw new Error("coder schedule failed");
    fake.done.push(`extend ${id} until ${deadline}`);
  };
  expect(await sweep(fake.coder, machine, { stopping: (name) => void stopping.push(name) })).toBe(1);
  expect(fake.done).toEqual(["stop box-idle", "extend ws-box-busy until 2026-11-01T02:00:00.000Z", "stop box-later"]);
  expect(stopping).toEqual(["box-idle", "box-later"]);
  expect(new Set(asked)).toEqual(new Set([`${launcher} box idle`]));
});

function spawnCoder(machineFileAfter = 2, listed: Box[] = []) {
  let checks = 0;
  const fake = fakeCoder({}, listed);
  fake.coder.ssh = async (name, command, stdin) => {
    fake.calls.push({ box: name, command, ...(stdin === undefined ? {} : { stdin }) });
    if (command === machineFileCheck) return { ...ok, code: ++checks > machineFileAfter ? 0 : 1 };
    return { ...ok, stdout: command.includes("t3 pair") ? "pair-code\n" : "" };
  };
  return fake;
}

test("spawning a new box waits for fleet apply's machine file, hands over the hub's files, sets it up, and links it on every devbox and the caller, never the hub over SSH", async () => {
  const home = hubHome();
  writeHome(home, { ".config/fleet/box-claude-token": "sk-secret-token\n" });
  const { machine, calls, lines } = onHub(home, { workspace: "my-hub", self: "hub-host", peers: ["my-hub", "devbox-1", "devbox-2"] });
  const spawned = spawnCoder();
  expect(await spawn(spawned.coder, machine, "Lane 7", { devbox: "devbox-3" })).toBe(0);
  expect(spawned.done).toEqual(["create box-lane-7 from my-hub with 120 GB"]);
  const commands = spawned.calls.map((call) => call.command);
  expect(commands.filter((command) => command === machineFileCheck)).toHaveLength(3);
  expect(commands.findIndex((command) => command.includes("box-claude-token"))).toBeGreaterThan(commands.lastIndexOf(machineFileCheck));
  expect(spawned.calls.find((call) => call.stdin === "sk-secret-token\n")?.command).toContain("umask 077");
  expect([...commands, ...calls].join("\n")).not.toContain("sk-secret-token");
  expect(commands.some((command) => command.includes("Lane 7 by devbox-3 at 2026-11-01"))).toBe(true);
  expect(calls.filter((call) => call.startsWith("peer")).sort()).toEqual(["devbox-1", "devbox-2", "devbox-3"].map((peer) => `peer ${peer}: ${launcher} box link box-lane-7`));
  expect(calls.some((call) => call.includes("-R' '60001:127.0.0.1:60001'"))).toBe(true);
  expect(lines.at(-1)).toBe("box-lane-7 env-box");
  expect(lines.join("\n")).not.toContain("not signed in");
  expect(registryOf(home).boxes["box-lane-7"]).toEqual({ id: "ws-box-lane-7", claim: expect.any(String) });
});

test("a spawn without a Claude token still works and says Claude is not signed in on the box; with Codex in the plan it names Codex's sign-in", async () => {
  const { machine, lines } = onHub(hubHome(), { codex: true });
  const spawned = spawnCoder(0);
  expect(await spawn(spawned.coder, machine, "lane")).toBe(0);
  expect(lines.join("\n")).toContain("Claude is not signed in on box-lane");
  expect(lines.join("\n")).toContain("fleet box run box-lane -- codex login --device-auth");
});

test("a spawn gives up when fleet apply never writes the machine file on the box, after a bounded wait on the injected clock", async () => {
  const { machine } = onHub(hubHome());
  const spawned = spawnCoder(Number.POSITIVE_INFINITY);
  await expect(spawn(spawned.coder, machine, "lane")).rejects.toThrow("did not finish fleet apply");
  expect(machine.now() - start).toBeLessThan(16 * 60_000);
});

test("a spawn claims a pooled box first, starts it by its recorded id, cleans it, and records who claimed it", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-pooled"], boxes: { "box-pooled": { id: "ws-box-pooled" } } });
  const { machine, calls, lines } = onHub(home);
  const spawned = spawnCoder(0, [box("box-pooled", "stopped")]);
  expect(await spawn(spawned.coder, machine, "lane", { devbox: "devbox-3" })).toBe(0);
  expect(spawned.done).toEqual(["start box-pooled"]);
  const claim = registryOf(home).boxes["box-pooled"]?.claim;
  expect(registryOf(home).boxes["box-pooled"]).toEqual({ id: "ws-box-pooled", claim: expect.any(String) });
  const commands = spawned.calls.map((call) => call.command);
  expect(commands.some((command) => command.includes("fleet-heavy.slice"))).toBe(true);
  expect(commands.some((command) => command.includes(`${claim} lane by devbox-3 at 2026-11-01`))).toBe(true);
  expect(calls.some((call) => call.startsWith("peer devbox-3:") && call.includes(`${launcher} box link box-pooled`))).toBe(true);
  expect(pooled(poolFile(home))).toEqual([]);
  expect(lines.at(-1)).toBe("box-pooled env-box");
});

test("the nightly pool refresh warms each free box with hub.boxWarmCommand in a login shell with a time limit, and only cleans it when no command is set", async () => {
  const home = hubHome();
  const file = poolFile(home);
  writePool(home, { free: ["box-a", "box-b"], boxes: { "box-a": { id: "ws-box-a" }, "box-b": { id: "ws-box-b" } } });
  const warmed = onHub(home, { settings: { ...fakeMachine(home).machine.settings, warmCommand: "make warm" } });
  const limits: Array<number | undefined> = [];
  let spawned = spawnCoder(0, [box("box-a", "stopped"), box("box-b", "stopped")]);
  const ssh = spawned.coder.ssh;
  spawned.coder.ssh = async (name, command, stdin, timeoutMs) => (command.startsWith("bash -lc") && limits.push(timeoutMs), ssh(name, command, stdin, timeoutMs));
  expect(await refreshPool(spawned.coder, warmed.machine)).toBe(0);
  const refreshCommands = spawned.calls.filter((call) => call.command.startsWith("bash -lc")).map((call) => call.command);
  expect(refreshCommands).toHaveLength(2);
  for (const command of refreshCommands) expect(command).toContain("make warm");
  expect(limits.every((limit) => typeof limit === "number" && limit > 0)).toBe(true);
  expect(spawned.done.filter((entry) => entry.startsWith("stop")).sort()).toEqual(["stop box-a", "stop box-b"]);
  expect(pooled(file).sort()).toEqual(["box-a", "box-b"]);
  const plain = onHub(home);
  spawned = spawnCoder(0, [box("box-a", "stopped"), box("box-b", "stopped")]);
  expect(await refreshPool(spawned.coder, plain.machine)).toBe(0);
  for (const call of spawned.calls.filter((entry) => entry.command.startsWith("bash -lc"))) {
    expect(call.command).toContain("fleet-heavy.slice");
    expect(call.command).not.toContain("make warm");
  }
});

test("the nightly job reaps, grants a Coder token to each profile devbox, refreshes the pool, and fails if any part failed", async () => {
  const { machine, lines } = fakeMachine(temp.make("fleet-box-"), { self: "my-hub", isHub: true, devboxes: ["devbox-1", "devbox-2"] });
  const steps = nightlySteps(machine, { reap: async () => 0, grant: async (devbox) => (devbox === "devbox-2" ? 1 : 0), refresh: async () => 0 });
  expect(steps.map((step) => step.name)).toEqual(["reap", "grant devbox-1", "grant devbox-2", "refresh the pool"]);
  expect(await nightly(steps, machine)).toBe(1);
  expect(lines.filter((line) => line.includes("failed"))).toEqual(["grant devbox-2 failed (exit 1)"]);
  const passing = nightlySteps(machine, { reap: async () => 0, grant: async () => 0, refresh: async () => { throw new Error("boom"); } });
  expect(await nightly(passing, machine)).toBe(1);
  expect(await nightly(nightlySteps(machine, { reap: async () => 0, grant: async () => 0, refresh: async () => 0 }), machine)).toBe(0);
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
  const { machine, lines } = fakeMachine(home, { isHub: role === "hub" });
  return { deps: depsFor(machine, () => fakeCoder().coder), lines };
}

test("on a machine that is not the hub, sweep, reap, pool, grant, and nightly refuse and say to run fleet hub here", async () => {
  const { deps } = commandDeps(temp.make("fleet-box-"), "devbox");
  for (const args of [["sweep"], ["reap"], ["pool", "list"], ["grant", "devbox-2"], ["nightly"]]) {
    await expect(boxCommand(args, deps)).rejects.toThrow("Run fleet hub here on the hub");
  }
  const hub = commandDeps(temp.make("fleet-box-"), "hub");
  expect(await boxCommand(["sweep"], hub.deps)).toBe(0);
});

test("an unknown box command prints the usage and fails, and the hold verbs the devboxes used are gone", async () => {
  const { deps, lines } = commandDeps(temp.make("fleet-box-"), "hub");
  const unknown = [
    ["launch"], ["release"], ["release", "box-lane", "--now"], ["run", "devbox-4", "--", "true"], ["run", "box-lane", "true"], ["run", "box-lane", "--"], ["spawn", "lane", "--old"], ["release", "box-lane", "--new"], ["pool", "empty"], ["token", "extra"],
    ["spawn", "--for"], ["start", "box-lane", "--for", "bad name"], ["link", "box-lane", "--for", "devbox-2"],
    ...["own", "claim", "hold", "renew", "unhold", "give", "drop"].map((verb) => ["pool", verb, "box-a", "t-1"]),
    ["pool", "claim"],
  ];
  for (const args of unknown) expect([args.join(" "), await boxCommand(args, deps)]).toEqual([args.join(" "), 2]);
  expect(lines.at(-1)).toContain("fleet box token");
  expect(lines.at(-1)).not.toMatch(/renew|unhold|claim, own/);
});

test("fleet box token reads the token from standard input", async () => {
  const home = temp.make("fleet-box-");
  const { deps } = commandDeps(home);
  expect(await boxCommand(["token"], { ...deps, readStdin: async () => "sk-from-stdin\n" })).toBe(0);
  expect(readFileSync(join(home, ".config/fleet/box-claude-token"), "utf8")).toBe("sk-from-stdin\n");
});

test("fleet box nightly exits 1 when a reaped box could not be released everywhere", async () => {
  const home = hubHome();
  const { machine, lines } = onHub(home, { devboxes: [], peers: ["devbox-2"], onPeer: async (alias) => ({ ...ok, code: alias === "devbox-2" ? 255 : 0 }) });
  machine.settings = { ...machine.settings, poolSize: 0 };
  writePool(home, { boxes: { "box-old": { id: "ws-box-old", claim: "c-1" } } });
  const { coder, done } = fakeCoder({}, [box("box-old", "stopped", { lastUsedAt: "2026-10-20T00:00:00Z" })]);
  expect(await boxCommand(["nightly"], depsFor(machine, () => coder))).toBe(1);
  expect(done).toEqual(["remove box-old"]);
  expect(lines).toContain("reap failed (exit 1)");
});

function hangingCoder(machine: { sleep(ms: number): Promise<void> }, fields: Parameters<typeof fakeCoder>[0] = {}) {
  const limits: number[] = [];
  const hang = (timeoutMs?: number) => {
    if (timeoutMs === undefined) throw new Error("hangs forever: no time limit");
    limits.push(timeoutMs);
    void machine.sleep(timeoutMs);
    return { code: 124, stdout: "", stderr: "timed out" };
  };
  return { limits, hang, ...fakeCoder({ sshAfterStartup: async (_box, _command, timeoutMs) => hang(timeoutMs), ...fields }, []) };
}

test("waiting for a new box gives up at its deadline even when every coder call hangs, because each call gets the time that is left", async () => {
  const { machine } = onHub(hubHome());
  const { coder, limits } = hangingCoder(machine);
  await expect(spawn(coder, machine, "lane")).rejects.toThrow("was not ready after 15 minutes");
  expect(machine.now() - start).toBeLessThanOrEqual(15 * 60_000);
  expect(limits.length).toBeGreaterThan(0);

  const applying = onHub(hubHome());
  const stuck = hangingCoder(applying.machine, { sshAfterStartup: async () => ok });
  stuck.coder.ssh = async (_box, _command, _stdin, timeoutMs) => stuck.hang(timeoutMs);
  await expect(spawn(stuck.coder, applying.machine, "lane")).rejects.toThrow("did not finish fleet apply");
  expect(applying.machine.now() - start).toBeLessThanOrEqual(15 * 60_000 + 5000);
});

test("linking gives up at its deadline when the box's T3 never answers a request, because each request gets the time that is left", async () => {
  const limits: number[] = [];
  const { machine } = fakeMachine(temp.make("fleet-box-"), {
    environmentId: async (_url, timeoutMs) => {
      if (timeoutMs === undefined) throw new Error("hangs forever: no time limit");
      limits.push(timeoutMs);
      await machine.sleep(timeoutMs);
      return undefined;
    },
  });
  await expect(link(fakeCoder().coder, machine, "box-lane")).rejects.toThrow("within a minute");
  expect(machine.now() - start).toBeLessThanOrEqual(60_000);
  expect(limits[0]).toBe(60_000);
});

test("an unrelated box-* workspace under the same Coder account survives sweep, spawn and reap, and is listed as skipped", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-personal"], boxes: { "box-mine": { id: "ws-box-mine", claim: "c-1" }, "box-moved": { id: "ws-box-moved", claim: "c-2" } } });
  const { machine, lines } = onHub(home, { devboxes: [], peers: ["devbox-2"] });
  const listed = [box("box-mine"), box("box-personal", "running", { id: "ws-personal" }), box("box-moved", "running", { template: "other" })];
  const { coder, calls, done } = spawnCoder(0, listed);
  const unrelated = () => [...calls.map((call) => call.box), ...done].filter((entry) => /box-(personal|moved)/.test(entry));

  expect(await sweep(coder, machine)).toBe(0);
  expect(done).toEqual(["stop box-mine"]);
  expect(lines).toContain("box-personal: skipped, not a box this pool made");
  expect(lines).toContain("box-moved: skipped, not a box this pool made");

  expect(await spawn(coder, machine, "lane")).toBe(0);
  expect(done).toContain("create box-lane from devbox-1 with 120 GB");
  expect(registryOf(home).boxes["box-lane"]?.id).toBe("ws-box-lane");

  for (const entry of listed) Object.assign(entry, { status: "stopped", lastUsedAt: "2026-10-20T00:00:00Z" });
  expect(await boxCommand(["reap"], depsFor(machine, () => coder))).toBe(0);
  expect(pooled(poolFile(home)).sort()).toEqual(["box-lane", "box-mine"]);
  expect(unrelated()).toEqual([]);
});

test("a release from a lane that no longer holds the box changes nothing: it checks the claim it read against the record under the box lock", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-old" } } });
  const { machine, lines } = onHub(home);
  let onBox = "c-old";
  let work = "";
  let interleaved = false;
  const listed = [box("box-lane")];
  const { coder, done } = fakeCoder({
    ssh: async (_box, command) => {
      const answer = await answers(() => onBox, () => work)(_box, command);
      if (!interleaved && command.startsWith("cut ")) {
        interleaved = true;
        expect(await release(coder, machine, "box-lane", noWait)).toBe(0);
        expect(await spawn(coder, machine, "new lane")).toBe(0);
        onBox = registryOf(home).boxes["box-lane"]!.claim!;
        work = "New lane (runs)\n";
      }
      return answer;
    },
  }, listed);
  expect(await release(coder, machine, "box-lane", noWait)).toBe(1);
  expect(done).toEqual(["stop box-lane", "start box-lane"]);
  expect(listed[0]?.status).toBe("running");
  expect(pooled(poolFile(home))).toEqual([]);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: onBox });
  expect(lines.join("\n")).toContain("claimed again");
});

test("fleet box start takes a pooled box out of the pool under its lock before it starts it, and fails with one line on a box another operation holds", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-a"], boxes: { "box-a": { id: "ws-box-a" }, "box-b": { id: "ws-box-b", claim: "c-1" } } });
  const { machine } = onHub(home);
  const during: { locked?: string; pooled?: string[] } = {};
  const fake = fakeCoder({}, [box("box-a", "stopped"), box("box-b", "stopped")]);
  const startById = fake.coder.start;
  fake.coder.start = async (id, timeoutMs) => {
    during.locked = await lockBox(home, "box-a", noWait).then(() => "free", (error) => (error instanceof BoxBusy ? "busy" : String(error)));
    during.pooled = pooled(poolFile(home));
    await startById(id, timeoutMs);
  };
  expect(await startBox(fake.coder, machine, "box-a", noWait)).toBe(0);
  expect(during).toEqual({ locked: "busy", pooled: [] });
  const claim = registryOf(home).boxes["box-a"]?.claim;
  expect(registryOf(home).boxes["box-a"]).toEqual({ id: "ws-box-a", claim: expect.any(String) });
  expect(fake.calls.some((call) => call.box === "box-a" && call.command.includes("box-claim") && call.command.includes(claim!))).toBe(true);
  const unlock = await lockBox(home, "box-b", noWait);
  await expect(startBox(fake.coder, machine, "box-b", noWait)).rejects.toThrow(/^box-b is busy: another fleet box operation on it still runs\. Try again in a few minutes\.$/);
  unlock();
  expect(fake.done).toEqual(["start box-a"]);
});

test("a user command waits for a busy box, says so, and runs once the other operation ends", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  const unlock = await lockBox(home, "box-lane", noWait);
  const { machine, lines } = onHub(home);
  const say = machine.say;
  machine.say = (line) => {
    say(line);
    if (line.includes("waiting")) unlock();
  };
  const { coder, done } = fakeCoder({}, [box("box-lane", "stopped")]);
  expect(await startBox(coder, machine, "box-lane", { waitMs: 60_000 })).toBe(0);
  expect(lines[0]).toBe("box-lane is busy; waiting up to 1 minute for the other operation on it to end");
  expect(done).toEqual(["start box-lane"]);
});

test("a reaped box that turns active while it is being released is neither stopped nor pooled, and keeps its claim", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-old": { id: "ws-box-old", claim: "c-1" } } });
  const listed = [box("box-old", "stopped", { lastUsedAt: "2026-10-20T00:00:00Z" })];
  const { machine, lines } = onHub(home, {
    devboxes: [], peers: ["devbox-2"],
    onPeer: async (_alias, command) => {
      if (command.includes("fleet-box-box-old-hub.service")) listed[0]!.status = "running";
      return ok;
    },
  });
  const { coder, done } = fakeCoder({}, listed);
  expect(await boxCommand(["reap"], depsFor(machine, () => coder))).toBe(1);
  expect(done).toEqual([]);
  expect(pooled(poolFile(home))).toEqual([]);
  expect(registryOf(home).boxes["box-old"]).toEqual({ id: "ws-box-old", claim: "c-1" });
  expect(lines.join("\n")).toContain("kept box-old");
});

test("fleet box start on a box a lane holds keeps a release out until the box is up, and a release's lock keeps a start out", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  const { machine } = onHub(home);
  const listed = [box("box-lane", "stopped")];
  let duringStart: unknown;
  const fake = fakeCoder({ ssh: answers(() => "c-1") }, listed);
  fake.coder.start = async () => {
    listed[0]!.status = "running";
    duringStart = await release(fake.coder, machine, "box-lane", noWait).catch((error) => error);
    fake.done.push("start box-lane");
  };
  expect(await startBox(fake.coder, machine, "box-lane", noWait)).toBe(0);
  expect(duringStart).toBeInstanceOf(BoxBusy);
  expect(fake.done).toEqual(["start box-lane"]);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1" });

  const unlock = await lockBox(home, "box-lane", noWait);
  await expect(startBox(fake.coder, machine, "box-lane", noWait)).rejects.toBeInstanceOf(BoxBusy);
  unlock();
  expect(fake.done).toEqual(["start box-lane"]);
});

test("a release lets go of its lock and its leaving mark when a step fails, so the next release runs", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  const { machine } = onHub(home);
  const listed = [box("box-lane")];
  let stops = 0;
  const fake = fakeCoder({ ssh: answers(() => "c-1") }, listed);
  const stop = fake.coder.stop;
  fake.coder.stop = async (id) => {
    if (stops++ === 0) throw new Error("coder stop failed");
    await stop(id);
  };
  await expect(release(fake.coder, machine, "box-lane")).rejects.toThrow("coder stop failed");
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1" });
  expect(await release(fake.coder, machine, "box-lane")).toBe(0);
  expect(pooled(poolFile(home))).toEqual(["box-lane"]);
});

test("a release whose delete fails keeps the box's record, so sweep, reap and the next release still own it", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  const { machine } = onHub(home);
  let deletes = 0;
  const fake = fakeCoder({ ssh: answers(() => "c-1") });
  const remove = fake.coder.remove;
  fake.coder.remove = async (id) => {
    if (deletes++ === 0) throw new Error("coder delete failed");
    await remove(id);
  };
  await expect(release(fake.coder, machine, "box-lane", { recycle: false })).rejects.toThrow("coder delete failed");
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1" });
  expect(await release(fake.coder, machine, "box-lane", { recycle: false })).toBe(0);
  expect(fake.done).toEqual(["remove box-lane"]);
  expect(registryOf(home).boxes["box-lane"]).toBeUndefined();
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

test("recycling clears hidden entries too: hidden repositories in ~/dev, hidden scratch files, hidden lanes and hidden project roots", () => {
  const home = temp.make("fleet-box-");
  writeHome(home, {
    "dev/.old-repo/secret": "old lane", "dev/notes/.kept-inside": "kept", "dev/.notes/x": "", "dev/..dots/y": "",
    ".t3/scratch/.old-secret": "old lane", ".t3/scratch/..twice": "old lane",
    ".t3/worktrees/project/.old-lane/secret": "old lane", ".t3/worktrees/.hidden-project/lane/secret": "old lane",
  });
  const bin = stubBin(temp.make("fleet-bin-"), ["systemctl"]);
  const run = Bun.spawnSync(["sh", "-c", recycleScript(["notes"])], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
  expect(run.exitCode).toBe(0);
  expect(readdirSync(join(home, "dev"))).toEqual(["notes"]);
  expect(readdirSync(join(home, "dev/notes"))).toEqual([".kept-inside"]);
  expect(readdirSync(join(home, ".t3/scratch"))).toEqual([]);
  expect(readdirSync(join(home, ".t3/worktrees/project"))).toEqual([]);
  expect(readdirSync(join(home, ".t3/worktrees/.hidden-project"))).toEqual([]);
});

function treeOf(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
}

test("recycling refuses a symlinked ~/dev and leaves the folders in its target alone", () => {
  const home = temp.make("fleet-box-");
  const elsewhere = temp.make("fleet-elsewhere-");
  writeHome(elsewhere, { "project/a": "keep me", "other/b": "keep me" });
  symlinkSync(elsewhere, join(home, "dev"));
  const bin = stubBin(temp.make("fleet-bin-"), ["systemctl"]);
  const before = treeOf(elsewhere);
  const run = Bun.spawnSync(["sh", "-c", recycleScript([])], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, stderr: "pipe" });
  expect(treeOf(elsewhere)).toEqual(before);
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr.toString()).toContain("symlink");
});

test("recycling removes a symlink under the T3 worktrees or in ~/dev itself, and never what it points to, even a kept folder", () => {
  const home = temp.make("fleet-box-");
  const outside = temp.make("fleet-outside-");
  writeHome(home, { "dev/notes/plan.md": "kept", "dev/notes/sub/x": "kept", ".t3/worktrees/real/lane/f": "" });
  writeHome(outside, { "secret/s": "kept" });
  mkdirSync(join(home, ".t3/worktrees"), { recursive: true });
  symlinkSync(join(home, "dev/notes"), join(home, ".t3/worktrees/notes-link"));
  symlinkSync(join(outside, "secret"), join(home, "dev/linked"));
  const bin = stubBin(temp.make("fleet-bin-"), ["systemctl"]);
  const run = Bun.spawnSync(["sh", "-c", recycleScript(["notes"])], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
  expect(run.exitCode).toBe(0);
  expect(treeOf(join(home, "dev/notes"))).toEqual(["plan.md", "sub", "sub/x"]);
  expect(treeOf(outside)).toEqual(["secret", "secret/s"]);
  expect(readdirSync(join(home, "dev"))).toEqual(["notes"]);
  expect(readdirSync(join(home, ".t3/worktrees"))).toEqual(["real"]);
  expect(readdirSync(join(home, ".t3/worktrees/real"))).toEqual([]);
});

test("the token drop-in never writes through a planted symlink, and refuses a symlinked drop-in folder", () => {
  const home = temp.make("fleet-box-");
  const elsewhere = temp.make("fleet-elsewhere-");
  writeHome(home, { ".config/fleet/box-claude-token": "sk-test-token\n" });
  writeHome(elsewhere, { target: "untouched\n" });
  const dir = join(home, ".config/systemd/user/t3code.service.d");
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(elsewhere, "target"), join(dir, "claude-token.conf.new"));
  const bin = stubBin(temp.make("fleet-bin-"), ["systemctl", "curl", "sleep"]);
  expect(runOnBox(setUpScript("claim"), home, bin).exitCode).toBe(0);
  expect(readFileSync(join(elsewhere, "target"), "utf8")).toBe("untouched\n");
  expect(statSync(join(dir, "claude-token.conf")).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir).filter((name) => name !== "claude-token.conf.new")).toEqual(["claude-token.conf"]);

  const linkedHome = temp.make("fleet-box-");
  const target = temp.make("fleet-elsewhere-");
  writeHome(linkedHome, { ".config/fleet/box-claude-token": "sk-test-token\n" });
  mkdirSync(join(linkedHome, ".config/systemd/user"), { recursive: true });
  symlinkSync(target, join(linkedHome, ".config/systemd/user/t3code.service.d"));
  const refused = runOnBox(setUpScript("claim"), linkedHome, bin);
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr.toString()).toContain("symlink");
  expect(readdirSync(target)).toEqual([]);
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

test("the token drop-in refuses a destination that is a folder or a symlink to one, and a symlink anywhere below the home folder", () => {
  const bin = stubBin(temp.make("fleet-bin-"), ["systemctl", "curl", "sleep"]);
  const dropIn = ".config/systemd/user/t3code.service.d";
  const homeWithToken = () => {
    const home = temp.make("fleet-box-");
    writeHome(home, { ".config/fleet/box-claude-token": "sk-test-token\n" });
    return home;
  };
  const refuses = (home: string) => {
    const run = runOnBox(setUpScript("claim"), home, bin);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("will not write the Claude token");
  };

  const linkedConf = homeWithToken();
  const folder = temp.make("fleet-elsewhere-");
  mkdirSync(join(linkedConf, dropIn), { recursive: true });
  symlinkSync(folder, join(linkedConf, dropIn, "claude-token.conf"));
  refuses(linkedConf);
  expect(readdirSync(folder)).toEqual([]);

  const folderConf = homeWithToken();
  mkdirSync(join(folderConf, dropIn, "claude-token.conf"), { recursive: true });
  refuses(folderConf);
  expect(readdirSync(join(folderConf, dropIn, "claude-token.conf"))).toEqual([]);

  for (const ancestor of [".config/systemd/user", ".config/systemd"]) {
    const linkedAncestor = homeWithToken();
    const target = temp.make("fleet-elsewhere-");
    mkdirSync(join(linkedAncestor, ancestor, ".."), { recursive: true });
    symlinkSync(target, join(linkedAncestor, ancestor));
    refuses(linkedAncestor);
    expect(readdirSync(target)).toEqual([]);
  }
});

test("saving the Claude token never writes through a file planted at a temporary name", async () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { victim: "keep\n", ".config/fleet/box-claude-token": "sk-old\n" });
  const path = join(home, ".config/fleet/box-claude-token");
  symlinkSync(join(home, "victim"), `${path}.${process.pid}.partial`);
  await saveToken(home, "sk-new\n");
  expect(readFileSync(join(home, "victim"), "utf8")).toBe("keep\n");
  expect(readFileSync(path, "utf8")).toBe("sk-new\n");
  expect(lstatSync(path).isSymbolicLink()).toBe(false);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("a pooled spawn holds the box's lock through setup and linking, so a release meanwhile is refused and no second spawn takes it", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-a"], boxes: { "box-a": { id: "ws-box-a" } } });
  const during: { release?: unknown; pooled?: string[] } = {};
  const { machine } = onHub(home, {
    environmentId: async () => {
      if (!("release" in during)) {
        during.release = await release(coder, machine, "box-a", { ...noWait, force: true }).catch((error) => error);
        during.pooled = pooled(poolFile(home));
      }
      return "env-box";
    },
  });
  const { coder, done } = spawnCoder(0, [box("box-a")]);
  expect(await spawn(coder, machine, "lane")).toBe(0);
  expect(during.release).toBeInstanceOf(BoxBusy);
  expect(during.pooled).toEqual([]);
  expect(done).toEqual([]);
  expect(registryOf(home).boxes["box-a"]).toEqual({ id: "ws-box-a", claim: expect.any(String) });
});

test("a new box's spawn holds its lock from before it creates it, so a forced release during setup is refused", async () => {
  const home = hubHome();
  const { machine } = onHub(home);
  let duringSetup: unknown;
  const fake = spawnCoder(0);
  const ssh = fake.coder.ssh;
  fake.coder.ssh = async (name, command, stdin, timeoutMs) => {
    if (command === machineFileCheck && duringSetup === undefined) duringSetup = await release(fake.coder, machine, "box-lane", { ...noWait, force: true }).catch((error) => error);
    return ssh(name, command, stdin, timeoutMs);
  };
  expect(await spawn(fake.coder, machine, "lane", { reuse: false })).toBe(0);
  expect(duringSetup).toBeInstanceOf(BoxBusy);
  expect(fake.done).toEqual(["create box-lane from devbox-1 with 120 GB"]);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: expect.any(String) });
});

test("round 4, finding 1: a workspace recreated under a pool box's name is never started, stopped or deleted by release, start, reap, spawn or sweep", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-pooled"], boxes: { "box-lane": { id: "ws-old", claim: "c-1" }, "box-pooled": { id: "ws-pooled-old" } } });
  const { machine, lines } = onHub(home);
  const recreated = box("box-lane", "running", { id: "ws-new" });
  const listed = [recreated, box("box-pooled", "stopped", { id: "ws-pooled-new" })];
  const fake = spawnCoder(0, listed);
  const ssh = fake.coder.ssh;
  fake.coder.ssh = async (name, command, stdin, timeoutMs) => (command.startsWith("cut ") ? { ...ok, stdout: "c-1\n" } : ssh(name, command, stdin, timeoutMs));
  const deps = depsFor(machine, () => fake.coder);

  expect(await release(fake.coder, machine, "box-lane", noWait)).toBe(1);
  expect(await release(fake.coder, machine, "box-lane", { ...noWait, force: true })).toBe(1);
  expect(await release(fake.coder, machine, "box-lane", { ...noWait, force: true, recycle: false })).toBe(1);
  expect(await startBox(fake.coder, machine, "box-lane", noWait)).toBe(1);
  Object.assign(recreated, { status: "stopped", lastUsedAt: "2026-10-20T00:00:00Z" });
  expect(await boxCommand(["reap"], deps)).toBe(0);
  expect(await spawn(fake.coder, machine, "lane 2")).toBe(0);
  expect(await sweep(fake.coder, machine)).toBe(0);

  expect(fake.done.filter((entry) => !entry.includes("box-lane-2"))).toEqual([]);
  expect(listed.map((entry) => `${entry.name} ${entry.id}`)).toEqual(["box-lane ws-new", "box-pooled ws-pooled-new", "box-lane-2 ws-box-lane-2"]);
  expect(fake.calls.filter((call) => call.box !== "box-lane-2" && !call.command.startsWith("cut "))).toEqual([]);
  expect(lines.join("\n")).toContain("Coder has another workspace named box-lane now");
  expect(Object.keys(registryOf(home).boxes)).toEqual(["box-lane-2"]);
});

test("round 4, finding 2: a spawn whose peer calls outlast the old 30-minute hold still holds its box, so another lane gets a different box", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-a"], boxes: { "box-a": { id: "ws-box-a" } } });
  const peers = Array.from({ length: 7 }, (_, index) => `devbox-${index + 1}`);
  const other: { release?: unknown } = {};
  const { machine, lines } = onHub(home, {
    peers,
    onPeer: async (_alias, command) => {
      await machine.sleep(10 * 60_000);
      if (command.includes("box link box-a") && !("release" in other)) {
        other.release = await release(fake.coder, machine, "box-a", { ...noWait, force: true }).catch((error) => error);
        expect(await spawn(fake.coder, machine, "other lane")).toBe(0);
      }
      return ok;
    },
  });
  const fake = spawnCoder(0, [box("box-a", "stopped")]);
  expect(await spawn(fake.coder, machine, "lane")).toBe(0);
  expect(machine.now() - start).toBeGreaterThan(60 * 60_000);
  expect(other.release).toBeInstanceOf(BoxBusy);
  expect(lines).toContain("box-other-lane env-box");
  expect(lines.at(-1)).toBe("box-a env-box");
  const claim = registryOf(home).boxes["box-a"]?.claim;
  expect(registryOf(home).boxes["box-a"]).toEqual({ id: "ws-box-a", claim: expect.any(String) });
  expect(fake.calls.some((call) => call.box === "box-a" && call.command.includes(`${claim} lane by my-hub`))).toBe(true);
  expect(fake.done).toEqual(["start box-a", "create box-other-lane from devbox-1 with 120 GB"]);
});

test("round 4, finding 3: setup writes credentials only while it holds the box, however long fleet apply takes", async () => {
  const home = hubHome();
  writeHome(home, { ".config/fleet/box-claude-token": "sk-secret-token\n" });
  const { machine } = onHub(home);
  let checks = 0;
  let during: unknown;
  const fake = spawnCoder(0);
  const ssh = fake.coder.ssh;
  fake.coder.ssh = async (name, command, stdin, timeoutMs) => {
    if (command === machineFileCheck && checks++ === 0) {
      await machine.sleep(40 * 60_000);
      during = await release(fake.coder, machine, "box-lane", { ...noWait, force: true }).catch((error) => error);
    }
    return ssh(name, command, stdin, timeoutMs);
  };
  expect(await spawn(fake.coder, machine, "lane")).toBe(0);
  expect(during).toBeInstanceOf(BoxBusy);
  expect(fake.calls.some((call) => call.stdin === "sk-secret-token\n")).toBe(true);
  expect(registryOf(home).boxes["box-lane"]?.id).toBe("ws-box-lane");
});

test("round 4, finding 3: setup writes no credentials and no claim to a workspace that was recreated under the box's name while it waited", async () => {
  const home = hubHome();
  writeHome(home, { ".config/fleet/box-claude-token": "sk-secret-token\n" });
  const { machine } = onHub(home);
  const listed: Box[] = [];
  const fake = spawnCoder(0, listed);
  const ssh = fake.coder.ssh;
  fake.coder.ssh = async (name, command, stdin, timeoutMs) => {
    if (command === machineFileCheck) listed[0]!.id = "ws-someone-else";
    return ssh(name, command, stdin, timeoutMs);
  };
  await expect(spawn(fake.coder, machine, "lane")).rejects.toThrow("box-lane is no longer the workspace this operation holds");
  expect(fake.calls.filter((call) => call.stdin !== undefined || call.command.includes("box-claim") || call.command.includes("fleet-heavy"))).toEqual([]);
});

test("round 4, finding 4: there is no lease to expire, so a sweep whose idle check takes 45 minutes still holds the box until it stops it", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-old" } } });
  const { machine } = onHub(home);
  const during: { release?: unknown; start?: unknown } = {};
  const fake = fakeCoder({}, [box("box-lane")]);
  fake.coder.ssh = async (_box, command) => {
    if (command.includes("box idle")) {
      await machine.sleep(45 * 60_000);
      during.release = await release(fake.coder, machine, "box-lane", noWait).catch((error) => error);
      during.start = await startBox(fake.coder, machine, "box-lane", noWait).catch((error) => error);
      return ok;
    }
    return { ...ok, stdout: command.startsWith("cut ") ? "c-old\n" : "" };
  };
  expect(await sweep(fake.coder, machine)).toBe(0);
  expect(during.release).toBeInstanceOf(BoxBusy);
  expect(during.start).toBeInstanceOf(BoxBusy);
  expect(fake.done).toEqual(["stop box-lane"]);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-old" });
});

const claimedAt = "at 2026-10-31T23:00:00.000Z";
const readsClaim = (command: string) => command.includes("box-claim") && !command.includes("printf");
const resumedLane = (claimOnBox: Record<string, string>, failing: Record<string, number> = {}) => async (name: string, command: string) => {
  if (readsClaim(command)) return { ...ok, code: failing[name] ?? 0, stdout: claimOnBox[name] ? `${claimOnBox[name]}\n` : "" };
  if (command.includes("box idle")) return { ...ok, code: 1, stdout: "busy\n" };
  if (command.includes("box threads")) return { ...ok, stdout: "Resumed lane (runs)\n" };
  return ok;
};

test("round 5, finding 1: fleet box start refuses a box whose release began and did not finish, in one line, and the sweep then finishes that release", async () => {
  for (const how of ["pool", "delete"] as const) {
    const home = hubHome();
    writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1", leaving: how } } });
    const { machine, lines } = onHub(home);
    const fake = fakeCoder({ ssh: resumedLane({ "box-lane": `c-1 lane by devbox-1 ${claimedAt}` }) }, [box("box-lane", "stopped")]);
    expect(await startBox(fake.coder, machine, "box-lane", { devbox: "devbox-1", waitMs: 0 })).toBe(1);
    expect(lines).toEqual(["box-lane: its release began and did not finish, so it is not started. The hub's sweep finishes the release; spawn another box."]);
    expect(fake.done).toEqual([]);
    expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1", leaving: how });
    expect(await sweep(fake.coder, machine)).toBe(0);
    expect(fake.done).toEqual(how === "pool" ? [] : ["remove box-lane"]);
    expect(registryOf(home).boxes).toEqual(how === "pool" ? { "box-lane": { id: "ws-box-lane" } } : {});
  }
});

test("round 5, finding 1: a start after a crashed claim resumes the box only for the caller whose claim the box records, clears the mark, and the sweep keeps it up while its threads run", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1", claiming: true } } });
  const { machine, lines } = onHub(home);
  const fake = fakeCoder({ ssh: resumedLane({ "box-lane": `c-1 my lane by devbox-1 ${claimedAt}` }) }, [box("box-lane", "stopped")]);
  expect(await startBox(fake.coder, machine, "box-lane", { devbox: "devbox-1", waitMs: 0 })).toBe(0);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1" });
  expect(lines.at(-1)).toBe("box-lane is up; its T3 forwards reconnect within a minute");
  expect(await sweep(fake.coder, machine)).toBe(0);
  expect(fake.done).toEqual(["start box-lane", "extend box-lane until 2026-11-01T02:00:00.000Z"]);
  expect(registryOf(home)).toEqual({ free: [], boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
});

test("round 5, finding 1: a start after a crashed claim refuses, in one line, a box whose recorded claim is another one or another caller's, and keeps the mark", async () => {
  for (const [claimOnBox, caller] of [["c-old lane by devbox-1", "devbox-1"], ["c-1 lane by devbox-2", "devbox-1"], ["", "devbox-1"]] as const) {
    const home = hubHome();
    writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1", claiming: true } } });
    const { machine, lines } = onHub(home);
    const fake = fakeCoder({ ssh: resumedLane({ "box-lane": claimOnBox && `${claimOnBox} ${claimedAt}` }) }, [box("box-lane", "stopped")]);
    expect(await startBox(fake.coder, machine, "box-lane", { devbox: caller, waitMs: 0 })).toBe(1);
    expect(lines).toEqual(["box-lane: a claim of it stopped half way, and the box holds no claim of yours, so it is not resumed. The hub's sweep returns it to the pool, or keeps it for the lane it holds."]);
    expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1", claiming: true });
    expect(fake.calls.some((call) => call.command.includes("printf"))).toBe(false);
  }
});

test("round 5, finding 1: the sweep never pools a box with a stale claiming mark whose box records the pool's claim, or whose claim it cannot read", async () => {
  const home = hubHome();
  writePool(home, {
    boxes: {
      "box-handover": { id: "ws-box-handover", claim: "c-1", claiming: true },
      "box-cleaned": { id: "ws-box-cleaned", claim: "c-2", claiming: true },
      "box-asleep": { id: "ws-box-asleep", claim: "c-3", claiming: true },
      "box-silent": { id: "ws-box-silent", claim: "c-4", claiming: true },
    },
  });
  const { machine, lines } = onHub(home);
  const listed = [box("box-handover"), box("box-cleaned"), box("box-asleep", "stopped"), box("box-silent")];
  const fake = fakeCoder({ ssh: resumedLane({ "box-handover": `c-1 fleet box start by devbox-1 ${claimedAt}` }, { "box-silent": 255 }) }, listed);
  expect(await sweep(fake.coder, machine)).toBe(0);
  expect(fake.done).toEqual(["extend box-handover until 2026-11-01T02:00:00.000Z", "stop box-cleaned"]);
  expect(registryOf(home)).toEqual({
    free: ["box-cleaned"],
    boxes: {
      "box-handover": { id: "ws-box-handover", claim: "c-1" },
      "box-cleaned": { id: "ws-box-cleaned" },
      "box-asleep": { id: "ws-box-asleep", claim: "c-3", claiming: true },
      "box-silent": { id: "ws-box-silent", claim: "c-4", claiming: true },
    },
  });
  expect(lines.filter((line) => !/^devbox-\d: done$/.test(line))).toEqual([
    "box-handover: an operation stopped half way after its lane claimed it; it stays the lane's",
    "box-handover: busy, kept up for 2 hours",
    "box-cleaned: an operation stopped half way; it goes back to the pool",
    "returned box-cleaned to the pool and stopped it; the next spawn claims it",
    "box-asleep: an operation stopped half way, and the box is stopped, so its claim cannot be read; kept until it runs",
    "box-silent: an operation stopped half way, and the box did not show its claim (exit 255); kept",
  ]);
});

test("the sweep skips a box another operation holds, and repairs each state a crashed operation leaves behind", async () => {
  const home = hubHome();
  writePool(home, {
    free: ["box-free"],
    refreshing: ["box-refreshing"],
    boxes: {
      "box-busy": { id: "ws-box-busy", claim: "c-1" },
      "box-leaving": { id: "ws-box-leaving", claim: "c-2", leaving: "pool" },
      "box-deleting": { id: "ws-box-deleting", claim: "c-3", leaving: "delete" },
      "box-spawned": { id: "ws-box-spawned", claim: "c-4", claiming: true },
      "box-gone": { id: "ws-box-gone", claim: "c-5" },
      "box-free": { id: "ws-box-free" },
      "box-refreshing": { id: "ws-box-refreshing" },
    },
  });
  const { machine, lines, calls } = onHub(home);
  const listed = [box("box-busy"), box("box-leaving"), box("box-deleting", "stopped"), box("box-spawned"), box("box-free"), box("box-refreshing", "stopped")];
  const { coder, done } = fakeCoder({}, listed);
  const unlock = await lockBox(home, "box-busy", noWait);
  expect(await sweep(coder, machine)).toBe(0);
  unlock();
  expect(done.sort()).toEqual(["remove box-deleting", "stop box-free", "stop box-leaving", "stop box-spawned"]);
  expect(calls.filter((call) => call.includes("box unlink")).length).toBe(2);
  expect(registryOf(home)).toEqual({
    free: ["box-free", "box-refreshing", "box-leaving", "box-spawned"],
    boxes: {
      "box-busy": { id: "ws-box-busy", claim: "c-1" },
      "box-leaving": { id: "ws-box-leaving" },
      "box-spawned": { id: "ws-box-spawned" },
      "box-free": { id: "ws-box-free" },
      "box-refreshing": { id: "ws-box-refreshing" },
    },
  });
  expect(lines.filter((line) => !/^devbox-\d: done$/.test(line))).toEqual([
    "box-busy: another operation holds it; skipped",
    "box-leaving: an operation stopped half way; it goes back to the pool",
    "returned box-leaving to the pool and stopped it; the next spawn claims it",
    "box-deleting: an operation stopped half way; it is deleted",
    "deleted box-deleting",
    "box-spawned: an operation stopped half way; it goes back to the pool",
    "returned box-spawned to the pool and stopped it; the next spawn claims it",
    "box-free: in the pool but running; stopped",
    "box-gone: the box the pool made is gone; forgot it",
  ]);
});

const hubKey = JSON.stringify({ baseUrl: "http://127.0.0.1:3317/mcphub", token: "hubkey" });

test("round 6, finding 1: a spawn checks the handed-over gateway key from the box before it reports success, and a failed check is a warning, not a failed spawn", async () => {
  for (const code of [0, 1]) {
    const home = hubHome();
    writeHome(home, { ".config/fleet/mcphub.client.json": hubKey });
    const { machine, lines, calls } = onHub(home);
    const spawned = spawnCoder(0);
    const ssh = spawned.coder.ssh;
    spawned.coder.ssh = async (name, command, stdin) => {
      if (!command.includes("mcphub check")) return ssh(name, command, stdin);
      spawned.calls.push({ box: name, command });
      return { ...ok, code, stderr: code ? "The MCP gateway at http://127.0.0.1:3317/mcphub does not answer. On the hub, run: fleet mcphub doctor\n" : "" };
    };
    expect(await spawn(spawned.coder, machine, "lane")).toBe(0);
    const commands = spawned.calls.map((call) => call.command);
    expect(commands.findIndex((command) => command.includes("mcphub check"))).toBeGreaterThan(commands.findIndex((command) => command.includes("mcphub.client.json")));
    expect(calls.some((call) => call.includes("'-R' '3317:127.0.0.1:3317'"))).toBe(true);
    expect(lines.at(-1)).toBe("box-lane env-box");
    expect(lines.filter((line) => line.includes("MCP gateway"))).toEqual(code ? ["box-lane cannot reach the hub's MCP gateway yet (The MCP gateway at http://127.0.0.1:3317/mcphub does not answer. On the hub, run: fleet mcphub doctor). Check it with fleet box run box-lane -- fleet mcphub check"] : []);
  }
});

test("round 6, finding 1: fleet box start brings back the box's hub forward with its gateway route, and restores the T3 forward of that box only", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-lane"], boxes: { "box-lane": { id: "ws-box-lane" } } });
  linkedHere(home);
  writeHome(home, { ".config/fleet/boxes/box-other.json": JSON.stringify({ environmentId: "env-2", port: 22000 }) });
  const started: string[] = [];
  const { machine } = onHub(home, {
    run: async (argv) => {
      if (argv[2] === "is-active") return { ...ok, code: 3 };
      if (argv[0] === "systemd-run") started.push(`${argv[3]} ${argv.at(-1)}`);
      return ok;
    },
  });
  const { coder } = fakeCoder({}, [box("box-lane", "stopped"), box("box-other", "stopped")]);
  expect(await startBox(coder, machine, "box-lane", noWait)).toBe(0);
  expect(started.map((line) => line.split(" ")[0])).toEqual(["--unit=fleet-box-box-lane-hub", "--unit=fleet-box-box-lane-t3"]);
  expect(started[0]).toContain("'-R' '3317:127.0.0.1:3317'");
  expect(started[1]).toContain("'21000:3773'");
});

const onBoxShell = (homes: Record<string, string>, bin = "/nonexistent") => (name: string, command: string) => {
  const ran = Bun.spawnSync(["sh", "-c", command], { env: { HOME: homes[name]!, PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  return { code: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
};

test("round 6, finding 2: the sweep keeps a box with a stale claiming mark whose claim file it cannot read, and says why, while a box with no claim file goes back to the pool", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-locked": { id: "ws-box-locked", claim: "c-1", claiming: true }, "box-empty": { id: "ws-box-empty", claim: "c-2", claiming: true } } });
  const homes = { "box-locked": temp.make("fleet-onbox-"), "box-empty": temp.make("fleet-onbox-") };
  writeHome(homes["box-locked"], { ".config/fleet/box-claim": `c-1 lane by devbox-1 ${claimedAt}\n` });
  chmodSync(join(homes["box-locked"], ".config/fleet/box-claim"), 0o000);
  const shell = onBoxShell(homes);
  const { machine, lines } = onHub(home);
  const fake = fakeCoder({
    ssh: async (name, command) => {
      if (readsClaim(command)) return shell(name, command);
      if (command.includes("box threads")) return { ...ok, stdout: "Running lane (runs)\n" };
      if (command.includes("box idle")) return { ...ok, code: 1, stdout: "busy\n" };
      return ok;
    },
  }, [box("box-locked"), box("box-empty")]);
  expect(await sweep(fake.coder, machine)).toBe(0);
  expect(fake.done).toEqual(["stop box-empty"]);
  expect(registryOf(home)).toEqual({ free: ["box-empty"], boxes: { "box-locked": { id: "ws-box-locked", claim: "c-1", claiming: true }, "box-empty": { id: "ws-box-empty" } } });
  const kept = lines.find((line) => line.startsWith("box-locked:"));
  expect(kept).toStartWith("box-locked: an operation stopped half way, and the box did not show its claim (exit 1: ");
  expect(kept).toContain("Permission denied");
  expect(kept).toEndWith("; kept");
});

test("round 6, finding 3: fleet box start holds the box through its last forward step, so a release and a replacement spawn wait, and the link record and the forward agree", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  linkedHere(home);
  const fake = fakeCoder({ ssh: async (_name, command) => ({ ...ok, stdout: command.includes("t3 pair") ? "pair-code\n" : "" }) }, [box("box-lane", "stopped")]);
  const meanwhile: unknown[] = [];
  const services: string[] = [];
  let interleaved = false;
  const { machine } = onHub(home, {
    peers: [],
    freePort: () => 22000,
    run: async (argv) => {
      if (argv[2] === "is-active") return { ...ok, code: 3 };
      if (argv[2] === "stop" && argv[3] === "fleet-box-box-lane-t3.service" && !interleaved) {
        interleaved = true;
        meanwhile.push(await release(fake.coder, machine, "box-lane", { force: true, recycle: false, waitMs: 0 }).catch((error) => error));
        meanwhile.push(await spawn(fake.coder, machine, "lane", { reuse: false, waitMs: 0 }).catch((error) => error));
      }
      if (argv[0] === "systemd-run" && argv[3] === "--unit=fleet-box-box-lane-t3") services.push(argv.at(-1)!);
      return ok;
    },
  });
  expect(await startBox(fake.coder, machine, "box-lane", noWait)).toBe(0);
  expect(meanwhile.map((outcome) => outcome instanceof BoxBusy)).toEqual([true, true]);
  const { port } = (await Bun.file(join(home, ".config/fleet/boxes/box-lane.json")).json()) as { port: number };
  expect(services.at(-1)).toContain(`'${port}:3773'`);
  expect(fake.done).toEqual(["start box-lane"]);
});

test("round 6, finding 3: a standalone restore holds each box while it restores its forward and skips a box another operation holds, and fleet box link holds its box", async () => {
  const home = hubHome();
  linkedHere(home);
  writeHome(home, { ".config/fleet/boxes/box-other.json": JSON.stringify({ environmentId: "env-2", port: 22000 }) });
  const probe = () => lockBox(home, "box-lane", noWait).then((unlock) => (unlock(), "free"), (error) => (error instanceof BoxBusy ? "busy" : String(error)));
  const during: string[] = [];
  const { machine, lines } = onHub(home, {
    run: async (argv) => {
      if (argv[2] === "is-active") return { ...ok, code: 3 };
      if (argv[0] === "systemd-run" || argv[1] === "environment") during.push(`${argv[0] === "systemd-run" ? argv[3] : argv[2]} ${await probe()}`);
      return ok;
    },
  });
  const coder = fakeCoder({ ssh: async (_name, command) => ({ ...ok, stdout: command.includes("t3 pair") ? "pair-code\n" : "" }) }).coder;
  const unlock = await lockBox(home, "box-other", noWait);
  expect(await restoreForwards(coder, machine)).toBe(0);
  unlock();
  expect(during).toEqual(["--unit=fleet-box-box-lane-t3 busy"]);
  expect(lines).toContain("box-other: another operation holds it; skipped");
  during.length = 0;
  expect(await boxCommand(["link", "box-lane"], depsFor(machine, () => coder))).toBe(0);
  expect(during).toEqual(["unlink busy", "--unit=fleet-box-box-lane-t3 busy", "link busy"]);
});

const lockedFolders = (home: string, folders: string[], mode: number) => folders.forEach((folder) => chmodSync(join(home, folder), mode));

test("round 6, finding 4: recycling fails when any removal fails, even when a later one succeeds: in ~/dev, under a project, and for symlinks", () => {
  const bin = stubBin(temp.make("fleet-bin-"), ["systemctl"]);
  const cases: { files: Record<string, string>; links: string[]; locked: string[]; left: string; gone: string }[] = [
    { files: { "dev/a-locked/secret": "old lane", "dev/z-removable/file": "" }, links: [], locked: ["dev/a-locked"], left: "dev/a-locked/secret", gone: "dev/z-removable" },
    { files: { ".t3/worktrees/b-project/lane/f": "" }, links: [".t3/worktrees/a-project/link"], locked: [".t3/worktrees/a-project"], left: ".t3/worktrees/a-project/link", gone: ".t3/worktrees/b-project/lane" },
    { files: { "dev/z-removable/file": "" }, links: [".t3/worktrees/project-link"], locked: [".t3/worktrees"], left: ".t3/worktrees/project-link", gone: "dev/z-removable" },
  ];
  for (const { files, links, locked, left, gone } of cases) {
    const home = temp.make("fleet-box-");
    writeHome(home, files);
    for (const path of links) {
      mkdirSync(join(home, path, ".."), { recursive: true });
      symlinkSync(home, join(home, path));
    }
    lockedFolders(home, locked, 0o500);
    const run = Bun.spawnSync(["sh", "-c", recycleScript([])], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, stderr: "pipe" });
    lockedFolders(home, locked, 0o700);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("Permission denied");
    expect(lstatSync(join(home, left), { throwIfNoEntry: false })).toBeDefined();
    expect(existsSync(join(home, gone))).toBe(false);
  }
});

test("round 6, finding 4: a spawn never hands out a pooled box whose cleaning left an old lane's file behind, and the pool refresh reports it", async () => {
  const bin = stubBin(temp.make("fleet-bin-"), ["systemctl"]);
  const dirtyBox = () => {
    const onBox = temp.make("fleet-onbox-");
    writeHome(onBox, { "dev/a-locked/secret": "old lane", "dev/z-removable/file": "" });
    lockedFolders(onBox, ["dev/a-locked"], 0o500);
    return onBox;
  };
  const recycling = (onBox: string, keepDirs: string[]) => {
    const ran = Bun.spawnSync(["sh", "-c", recycleScript(keepDirs)], { env: { HOME: onBox, PATH: `${bin}:/usr/bin:/bin` }, stderr: "pipe" });
    return { code: ran.exitCode, stdout: "", stderr: ran.stderr.toString() };
  };

  const home = hubHome();
  writePool(home, { free: ["box-dirty"], boxes: { "box-dirty": { id: "ws-box-dirty" } } });
  const onBox = dirtyBox();
  const { machine, lines } = onHub(home, { peers: [] });
  const spawned = spawnCoder(0, [box("box-dirty", "stopped")]);
  const ssh = spawned.coder.ssh;
  spawned.coder.ssh = async (name, command, stdin) => (name === "box-dirty" && command.includes("fleet-heavy.slice") ? recycling(onBox, machine.settings.keepDirs) : ssh(name, command, stdin));
  expect(await spawn(spawned.coder, machine, "lane")).toBe(0);
  lockedFolders(onBox, ["dev/a-locked"], 0o700);
  expect(lines.at(-1)).toBe("box-lane env-box");
  expect(lines.find((line) => line.startsWith("box-dirty from the pool failed"))).toContain("Permission denied");
  expect(spawned.calls.filter((call) => call.box === "box-dirty").some((call) => call.command.includes("box-claim") && call.command.includes("printf"))).toBe(false);
  expect(spawned.done).toEqual(["start box-dirty", "create box-lane from devbox-1 with 120 GB"]);

  const refreshHome = hubHome();
  writePool(refreshHome, { free: ["box-dirty"], boxes: { "box-dirty": { id: "ws-box-dirty" } } });
  const refreshBox = dirtyBox();
  const refreshing = onHub(refreshHome, { peers: [] });
  const fake = fakeCoder({ ssh: async (_name, command) => (command.includes("fleet-heavy.slice") ? recycling(refreshBox, []) : { ...ok, stdout: command.includes("t3 pair") ? "pair-code\n" : "" }) }, [box("box-dirty", "stopped")]);
  expect(await refreshPool(fake.coder, refreshing.machine)).toBe(1);
  lockedFolders(refreshBox, ["dev/a-locked"], 0o700);
  expect(refreshing.lines).toContain("box-dirty: refresh failed (exit 1); kept in the pool");
});
