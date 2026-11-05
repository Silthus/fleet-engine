import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import {
  claimScript, isIdle, nightly, nightlySteps, poolAt, poolOn, recycleScript, refreshPool, release, saveToken, setUpScript, spawn, startBox, startLimitMs, sweep, unfinishedThreads, type PoolClient,
} from "./box.ts";
import { boxCommand } from "./box-command.ts";
import { claim, give, hold, holdMs, poolFile, pooled, unhold } from "./pool.ts";
import { link } from "./links.ts";
import { box, changePoolNow, fakeCoder, fakeMachine, linkedHere, ok, start, stubBin, writeHome, writePool } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const launcher = 'sh "$HOME/.local/share/fleet/engine/fleet"';

function poolClient(room: boolean) {
  const calls: string[] = [];
  const client: PoolClient = {
    own: async () => ({ claim: "c-1", token: "t-1" }),
    claim: async () => undefined,
    hold: async (box) => (calls.push(`hold ${box}`), { state: "held", token: "t-1" }),
    renew: async (box) => (calls.push(`renew ${box}`), true),
    unhold: async (box) => void calls.push(`unhold ${box}`),
    give: async (box) => (calls.push(`give ${box}`), room),
    drop: async (box, key) => void calls.push(`drop ${box} ${key}`),
  };
  return { client, calls };
}

const localPool = (machine: { home: string }) => poolAt(poolFile(machine.home), 4);

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
  const stopped = fakeCoder({ boxes: async () => [box("box-lane", "stopped")] });
  const gone = fakeCoder({ boxes: async () => [] });
  const silent = fakeCoder({ ssh: async () => ({ code: 255, stdout: "", stderr: "connection refused" }) });
  for (const { coder, done } of [stopped, gone, silent]) {
    expect(await release(coder, machine, "box-lane")).toBe(1);
    expect(done).toEqual([]);
  }
  expect(stopped.calls).toEqual([]);
});

test("a forced release deletes a box without asking about its threads", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, calls, done } = fakeCoder({ boxes: async () => [box("box-lane", "stopped")] });
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
  client.give = async (box, token) => {
    expect(done).toContain("stop box-lane");
    return giveBack(box, token);
  };
  expect(await release(coder, machine, "box-lane", { pool: client })).toBe(0);
  expect(asked).toEqual(["hold box-lane", "renew box-lane", "give box-lane"]);
  expect(done).toEqual(["stop box-lane"]);
  expect(existsSync(record)).toBe(true);
  expect(calls.filter((call) => call.includes("unlink"))).toEqual([]);
  expect(calls).toContain("run systemctl --user stop fleet-box-box-lane-hub.service");
});

test("release deletes the box when the pool is full, and drops it from the pool only after the delete", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, done } = fakeCoder();
  const { client, calls: asked } = poolClient(false);
  const remove = coder.remove;
  coder.remove = (box) => (asked.push(`remove ${box}`), remove(box));
  expect(await release(coder, machine, "box-lane", { pool: client })).toBe(0);
  expect(asked).toEqual(["hold box-lane", "renew box-lane", "give box-lane", "renew box-lane", "remove box-lane", "drop box-lane t-1"]);
  expect(done).toEqual(["stop box-lane", "remove box-lane"]);
});

test("a devbox asks the hub at hub.alias about the pool through the engine launcher, and keeps the box when the hub cannot answer", async () => {
  const asked: string[] = [];
  const { machine } = fakeMachine(temp.make("fleet-box-"), {
    onPeer: async (alias, command) => {
      asked.push(`${alias}: ${command}`);
      if (command.includes("box pool give")) return { ...ok, code: 255 };
      return { ...ok, stdout: command.includes("box pool hold") ? "t-1\n" : "" };
    },
  });
  const { coder, done } = fakeCoder();
  await expect(release(coder, machine, "box-lane", { pool: poolOn(machine) })).rejects.toThrow("stays stopped");
  expect(asked).toContain(`my-hub: ${launcher} box pool hold 'box-lane' 'ws-box-lane' ''`);
  expect(asked).toContain(`my-hub: ${launcher} box pool give 'box-lane' 't-1'`);
  expect(done).toEqual(["stop box-lane"]);
});

test("the hub keeps the pool in its own file, sized by hub.boxPoolSize", async () => {
  const home = temp.make("fleet-box-");
  const { machine } = fakeMachine(home, { isHub: true });
  const pool = poolOn(machine);
  for (const name of ["box-a", "box-b", "box-c", "box-d", "box-e"]) {
    expect(await pool.give(name, (await pool.own(name, `ws-${name}`)).token)).toBe(name !== "box-e");
  }
  expect((await pool.claim())?.box).toBe("box-a");
  expect(pooled(poolFile(home))).toEqual(["box-b", "box-c", "box-d"]);
});

test("release keeps a busy box out of the pool: it checks the threads while it holds the box, then lets go", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, done } = fakeCoder({ ssh: async (_box, command) => ({ ...ok, stdout: command.includes("box threads") ? "Lane A (runs)\n" : "c-1\n" }) });
  const { client, calls: asked } = poolClient(true);
  expect(await release(coder, machine, "box-lane", { pool: client })).toBe(1);
  expect(asked).toEqual(["hold box-lane", "unhold box-lane"]);
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

test("the sweep asks each running box through the engine launcher, stops idle ones, keeps busy ones up, and goes on after a Coder error", async () => {
  const answers: Record<string, number> = { "box-idle": 0, "box-busy": 1, "box-old": 127, "box-flaky": 1, "box-later": 0 };
  const asked: string[] = [];
  const stopping: string[] = [];
  const home = temp.make("fleet-box-");
  writePool(home, { boxes: Object.fromEntries(["box-idle", "box-busy", "box-old", "box-stopped", "box-flaky", "box-later"].map((name) => [name, { id: `ws-${name}`, claim: `c-${name}` }])) });
  const { machine } = fakeMachine(home);
  const { coder, done } = fakeCoder({
    boxes: async () => [box("box-idle"), box("box-busy"), box("box-old"), box("box-stopped", "stopped"), box("box-flaky"), box("box-later")],
    ssh: async (name, command) => (asked.push(command), { ...ok, code: answers[name]! }),
    extend: async (name, duration) => {
      if (name === "box-flaky") throw new Error("coder schedule failed");
      done.push(`extend ${name} ${duration}`);
    },
  });
  expect(await sweep(coder, machine, localPool(machine), { stopping: (name) => void stopping.push(name) })).toBe(1);
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

function spawnCoder(machineFileAfter = 2) {
  let checks = 0;
  const running = ["box-lane", "box-lane-7", "box-pooled", "box-a", "box-b"].map((name) => box(name));
  return fakeCoder({
    boxes: async () => running,
    ssh: async (box, command, stdin) => {
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
  expect(await spawn(spawned.coder, machine, "Lane 7", localPool(machine))).toBe(0);
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
  expect(await spawn(spawned.coder, machine, "lane", localPool(machine))).toBe(0);
  expect(lines.join("\n")).toContain("Claude is not signed in on box-lane");
  expect(lines.join("\n")).toContain("fleet box run box-lane -- codex login --device-auth");
});

test("a spawn gives up when fleet apply never writes the machine file on the box, after a bounded wait on the injected clock", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  spawned = spawnCoder(Number.POSITIVE_INFINITY);
  await expect(spawn(spawned.coder, machine, "lane", localPool(machine))).rejects.toThrow("did not finish fleet apply");
  expect(machine.now() - start).toBeLessThan(16 * 60_000);
});

test("a spawn claims a pooled box first, cleans it, and records who claimed it", async () => {
  const { machine, calls, lines } = fakeMachine(temp.make("fleet-box-"));
  spawned = spawnCoder(0);
  let claims = 0;
  const { client: pool } = poolClient(true);
  pool.claim = async () => (claims++ === 0 ? { box: "box-pooled", id: "ws-box-pooled", claim: "c-9", token: "t-9" } : undefined);
  expect(await spawn(spawned.coder, machine, "lane", pool)).toBe(0);
  expect(spawned.done).toEqual([]);
  const commands = spawned.calls.map((call) => call.command);
  expect(commands.some((command) => command.includes("fleet-heavy.slice"))).toBe(true);
  expect(commands.some((command) => command.includes("c-9 lane by devbox-1 at 2026-11-01"))).toBe(true);
  expect(calls.some((call) => call.startsWith("peer my-hub:") && call.includes(`${launcher} box link box-pooled`))).toBe(true);
  expect(lines.at(-1)).toBe("box-pooled env-box");
});

test("the nightly pool refresh warms each free box with hub.boxWarmCommand in a login shell, and only cleans it when no command is set", async () => {
  const home = temp.make("fleet-box-");
  const file = poolFile(home);
  writePool(home, { free: ["box-a", "box-b"], boxes: { "box-a": { id: "ws-box-a" }, "box-b": { id: "ws-box-b" } } });
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

test("fleet box nightly exits 1 when a reaped box could not be released everywhere", async () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub" }) });
  const { machine, lines } = fakeMachine(home, {
    self: "my-hub", isHub: true, devboxes: [], peers: ["devbox-2"],
    onPeer: async (alias) => ({ ...ok, code: alias === "devbox-2" ? 255 : 0 }),
  });
  machine.settings = { ...machine.settings, poolSize: 0 };
  writePool(home, { boxes: { "box-old": { id: "ws-box-old", claim: "c-1" } } });
  const stale = box("box-old", "stopped", { lastUsedAt: "2026-10-20T00:00:00Z" });
  const { coder, done } = fakeCoder({ boxes: async () => [stale] });
  expect(await boxCommand(["nightly"], { machine: () => machine, coder: () => coder, readStdin: async () => "", hooks: {} })).toBe(1);
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
  return { limits, hang, ...fakeCoder({ sshAfterStartup: async (_box, _command, timeoutMs) => hang(timeoutMs), ...fields }) };
}

test("waiting for a new box gives up at its deadline even when every coder call hangs, because each call gets the time that is left", async () => {
  const { machine } = fakeMachine(temp.make("fleet-box-"));
  const { coder, limits } = hangingCoder(machine);
  await expect(spawn(coder, machine, "lane", localPool(machine))).rejects.toThrow("was not ready after 15 minutes");
  expect(machine.now() - start).toBeLessThanOrEqual(15 * 60_000);
  expect(limits.length).toBeGreaterThan(0);

  const applying = fakeMachine(temp.make("fleet-box-"));
  const stuck = hangingCoder(applying.machine, { sshAfterStartup: async () => ok });
  stuck.coder.ssh = async (_box, _command, _stdin, timeoutMs) => stuck.hang(timeoutMs);
  await expect(spawn(stuck.coder, applying.machine, "lane", localPool(applying.machine))).rejects.toThrow("did not finish fleet apply");
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

function hubHome() {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub" }) });
  return home;
}

const registryOf = (home: string) => JSON.parse(readFileSync(poolFile(home), "utf8")) as { free: string[]; refreshing: string[]; boxes: Record<string, { id: string; claim?: string; hold?: unknown }> };
const claimOnBox = (claim: string) => async (_box: string, command: string) => ({ ...ok, stdout: command.includes("box-claim") ? `${claim}\n` : "" });

test("an unrelated box-* workspace under the same Coder account survives sweep, spawn and reap, and is listed as skipped", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-personal"], boxes: { "box-mine": { id: "ws-box-mine", claim: "c-1" }, "box-moved": { id: "ws-box-moved", claim: "c-2" } } });
  const { machine, lines } = fakeMachine(home, { self: "my-hub", isHub: true, devboxes: [], peers: ["devbox-2"] });
  const listed = [box("box-mine"), box("box-personal", "running", { id: "ws-personal" }), box("box-moved", "running", { template: "other" })];
  const { coder, calls, done } = fakeCoder({
    boxes: async () => listed,
    ssh: async (name, command) => (calls.push({ box: name, command }), { ...ok, stdout: command.includes("t3 pair") ? "pair-code\n" : "" }),
    create: async (name) => (done.push(`create ${name}`), listed.push(box(name)), `ws-${name}`),
  });
  const unrelated = () => [...calls.map((call) => call.box), ...done].filter((entry) => /box-(personal|moved)/.test(entry));

  expect(await sweep(coder, machine, poolOn(machine))).toBe(0);
  expect(done).toEqual(["stop box-mine"]);
  expect(lines).toContain("box-personal: skipped, not a box this pool made");
  expect(lines).toContain("box-moved: skipped, not a box this pool made");

  expect(await spawn(coder, machine, "lane", poolOn(machine))).toBe(0);
  expect(done).toContain("create box-lane");
  expect(registryOf(home).boxes["box-lane"]?.id).toBe("ws-box-lane");

  for (const entry of listed) Object.assign(entry, { status: "stopped", lastUsedAt: "2026-10-20T00:00:00Z" });
  const deps = { machine: () => machine, coder: () => coder, readStdin: async () => "", hooks: {} };
  expect(await boxCommand(["reap"], deps)).toBe(0);
  expect(pooled(poolFile(home)).sort()).toEqual(["box-lane", "box-mine"]);
  expect(unrelated()).toEqual([]);
});

test("a release that read an older claim neither stops nor pools a box that was claimed again since", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-new" } } });
  const { machine, lines } = fakeMachine(home, { isHub: true });
  const { coder, done } = fakeCoder({ ssh: async (_box, command) => ({ ...ok, stdout: command.includes("box-claim") ? "c-old\n" : "" }) });
  expect(await release(coder, machine, "box-lane", { pool: poolOn(machine) })).toBe(1);
  expect(done).toEqual([]);
  expect(pooled(poolFile(home))).toEqual([]);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-new" });
  expect(lines.join("\n")).toContain("claimed again");
});

test("fleet box start takes a pooled box out of the pool before it starts it, and refuses one the pool is refreshing", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-a"], refreshing: ["box-b"], boxes: { "box-a": { id: "ws-box-a" }, "box-b": { id: "ws-box-b" } } });
  const { machine, lines } = fakeMachine(home, { isHub: true });
  let claimedMeanwhile: unknown = "not asked";
  const { coder, calls, done } = fakeCoder({
    boxes: async () => [box("box-a"), box("box-b", "stopped")],
    start: async (name) => {
      claimedMeanwhile = await poolOn(machine).claim();
      done.push(`start ${name}`);
    },
  });
  expect(await startBox(coder, machine, "box-a", poolOn(machine))).toBe(0);
  expect(claimedMeanwhile).toBeUndefined();
  expect(pooled(poolFile(home))).toEqual(["box-b"]);
  const claim = registryOf(home).boxes["box-a"]?.claim;
  expect(claim).toBeString();
  expect(calls.some((call) => call.box === "box-a" && call.command.includes("box-claim") && call.command.includes(claim!))).toBe(true);
  expect(await startBox(coder, machine, "box-b", poolOn(machine))).toBe(1);
  expect(done).toEqual(["start box-a"]);
  expect(lines.join("\n")).toContain("box-b is busy");
});

test("a reaped box that turns active while it is being released is neither stopped nor pooled, and keeps its claim", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-old": { id: "ws-box-old", claim: "c-1" } } });
  const stale = box("box-old", "stopped", { lastUsedAt: "2026-10-20T00:00:00Z" });
  const { machine, lines } = fakeMachine(home, {
    self: "my-hub", isHub: true, devboxes: [], peers: ["devbox-2"],
    onPeer: async (_alias, command) => {
      if (command.includes("fleet-box-box-old-hub.service")) stale.status = "running";
      return ok;
    },
  });
  const { coder, done } = fakeCoder({ boxes: async () => [stale] });
  expect(await boxCommand(["reap"], { machine: () => machine, coder: () => coder, readStdin: async () => "", hooks: {} })).toBe(1);
  expect(done).toEqual([]);
  expect(pooled(poolFile(home))).toEqual([]);
  expect(registryOf(home).boxes["box-old"]).toEqual({ id: "ws-box-old", claim: "c-1" });
  expect(lines.join("\n")).toContain("kept box-old");
});

test("a release holds the claim it read before it checks for unfinished work, so a lane that claimed the box in between is never pooled unchecked", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-old" } } });
  const { machine } = fakeMachine(home, { isHub: true });
  let onBox = "c-old";
  let work = "";
  let interleaved = false;
  let spawnClaim: string | undefined;
  const otherReleaseThenSpawn = () => {
    interleaved = true;
    changePoolNow(home, (pool) => {
      const other = hold(pool, machine.now(), "box-lane", "ws-box-lane", "c-old");
      if (other.state !== "held") return;
      give(pool, "box-lane", other.token, 4);
      const spawned = claim(pool, machine.now());
      if (spawned) unhold(pool, "box-lane", spawned.token);
      spawnClaim = spawned?.claim;
      onBox = spawnClaim!;
      work = "New lane (runs)\n";
    });
  };
  const { coder, done } = fakeCoder({
    ssh: async (_box, command) => {
      const answer = { ...ok, stdout: command.includes("box-claim") ? `${onBox}\n` : command.includes("box threads") ? work : "" };
      if (!interleaved) otherReleaseThenSpawn();
      return answer;
    },
  });
  expect(await release(coder, machine, "box-lane", { pool: poolOn(machine) })).toBe(1);
  expect(done).toEqual([]);
  expect(pooled(poolFile(home))).toEqual([]);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: spawnClaim });
});

test("fleet box start on a box a lane holds keeps a release out until the box is up, and a release's hold keeps a start out", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  const { machine, lines } = fakeMachine(home, { isHub: true });
  let duringStart: number | undefined;
  const { coder, done } = fakeCoder({
    ssh: claimOnBox("c-1"),
    start: async (name) => {
      duringStart = await release(coder, machine, name, { pool: poolOn(machine) });
      done.push(`start ${name}`);
    },
  });
  expect(await startBox(coder, machine, "box-lane", poolOn(machine))).toBe(0);
  expect(duringStart).toBe(1);
  expect(done).toEqual(["start box-lane"]);
  expect(pooled(poolFile(home))).toEqual([]);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1" });
  expect(lines.join("\n")).toContain("a start, a sweep or a release holds it");

  const releasing = await poolOn(machine).hold("box-lane", "ws-box-lane", "c-1");
  expect(releasing.state).toBe("held");
  expect(await startBox(coder, machine, "box-lane", poolOn(machine))).toBe(1);
  expect(done).toEqual(["start box-lane"]);
});

test("a release lets go of its hold when a step fails, so the next release runs", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  const { machine } = fakeMachine(home, { isHub: true });
  let stops = 0;
  const { coder, done } = fakeCoder({
    ssh: claimOnBox("c-1"),
    stop: async (name) => {
      if (stops++ === 0) throw new Error("coder stop failed");
      done.push(`stop ${name}`);
    },
  });
  await expect(release(coder, machine, "box-lane", { pool: poolOn(machine) })).rejects.toThrow("coder stop failed");
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1" });
  expect(await release(coder, machine, "box-lane", { pool: poolOn(machine) })).toBe(0);
  expect(pooled(poolFile(home))).toEqual(["box-lane"]);
});

test("a release that dies in the middle leaves a hold that blocks the box only until it expires; the takeover fences the dead release out", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  const { machine, lines } = fakeMachine(home, { isHub: true });
  const hub = poolOn(machine);
  let dead = "";
  const lostHub: PoolClient = {
    ...hub,
    hold: async (name, id, claim) => {
      const held = await hub.hold(name, id, claim);
      if (held.state === "held") dead = held.token;
      return held;
    },
    unhold: async () => {
      throw new Error("the hub did not answer");
    },
  };
  const dying = fakeCoder({
    ssh: claimOnBox("c-1"),
    stop: async () => {
      throw new Error("the box went away mid-stop");
    },
  });
  await expect(release(dying.coder, machine, "box-lane", { pool: lostHub })).rejects.toThrow("mid-stop");
  expect(dead).not.toBe("");

  const { coder, done } = fakeCoder({ boxes: async () => [box("box-lane", "stopped")] });
  expect(await release(coder, machine, "box-lane", { force: true, pool: hub })).toBe(1);
  expect(lines.at(-1)).toContain("holds it");
  await machine.sleep(holdMs);
  expect(await release(coder, machine, "box-lane", { force: true, pool: hub })).toBe(0);
  expect(pooled(poolFile(home))).toEqual(["box-lane"]);
  expect(await hub.renew("box-lane", dead)).toBe(false);
  await expect(hub.give("box-lane", dead)).rejects.toThrow("no longer held");
  await hub.drop("box-lane", dead);
  expect(pooled(poolFile(home))).toEqual(["box-lane"]);
  expect(done).toEqual([]);
});

test("a release whose delete fails keeps the box's record and lets go of its hold, so sweep, reap and the next release still own it", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" } } });
  const { machine } = fakeMachine(home, { isHub: true });
  let deletes = 0;
  const { coder, done } = fakeCoder({
    ssh: claimOnBox("c-1"),
    remove: async (name) => {
      if (deletes++ === 0) throw new Error("coder delete failed");
      done.push(`remove ${name}`);
    },
  });
  await expect(release(coder, machine, "box-lane", { pool: poolOn(machine), recycle: false })).rejects.toThrow("coder delete failed");
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-1" });
  expect(await release(coder, machine, "box-lane", { pool: poolOn(machine), recycle: false })).toBe(0);
  expect(done).toEqual(["remove box-lane"]);
  expect(registryOf(home).boxes["box-lane"]).toBeUndefined();
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

const claimRead = (home: string, box: string) => (command: string) => (command.startsWith("cut ") ? `${registryOf(home).boxes[box]?.claim}\n` : "");

test("a pooled spawn holds the box through setup and linking, so a release meanwhile neither returns it nor lets a second spawn take it", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-a"], boxes: { "box-a": { id: "ws-box-a" } } });
  const during: { release?: number; second?: string } = {};
  const { machine } = fakeMachine(home, {
    isHub: true,
    environmentId: async () => {
      if (!("release" in during)) {
        during.release = await release(coder, machine, "box-a", { pool: poolOn(machine) });
        during.second = (await poolOn(machine).claim())?.box;
      }
      return "env-box";
    },
  });
  const { coder, done } = fakeCoder({
    boxes: async () => [box("box-a")],
    ssh: async (_box, command) => ({ ...ok, stdout: command.includes("t3 pair") ? "pair-code\n" : claimRead(home, "box-a")(command) }),
  });
  expect(await spawn(coder, machine, "lane", poolOn(machine))).toBe(0);
  expect(during).toEqual({ release: 1, second: undefined });
  expect(done).toEqual([]);
  expect(pooled(poolFile(home))).toEqual([]);
  expect(registryOf(home).boxes["box-a"]).toEqual({ id: "ws-box-a", claim: expect.any(String) });
});

test("a new box's spawn holds it from the moment the pool records it, so a forced release during setup cannot delete it", async () => {
  const home = hubHome();
  const { machine } = fakeMachine(home, { isHub: true });
  let duringSetup: number | undefined;
  const { coder, done } = fakeCoder({
    boxes: async () => [box("box-lane")],
    ssh: async (_box, command) => {
      if (command === "test -f ~/.config/fleet/machine.json" && duringSetup === undefined) duringSetup = await release(coder, machine, "box-lane", { force: true, pool: poolOn(machine) });
      return { ...ok, stdout: command.includes("t3 pair") ? "pair-code\n" : "" };
    },
  });
  expect(await spawn(coder, machine, "lane", poolOn(machine), false)).toBe(0);
  expect(duringSetup).toBe(1);
  expect(done).toEqual(["create box-lane from devbox-1 with 120 GB"]);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: expect.any(String) });
});

test("an expired start never overwrites the claim of the operation that took the box over, and its start call has a time limit", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-a"], boxes: { "box-a": { id: "ws-box-a" } } });
  const { machine, lines } = fakeMachine(home, { isHub: true });
  const limits: number[] = [];
  let replacement: string | undefined;
  const { coder, calls } = fakeCoder({
    boxes: async () => [box("box-a")],
    start: async (_name, timeoutMs) => {
      limits.push(timeoutMs);
      await machine.sleep(holdMs);
      changePoolNow(home, (pool) => {
        const takeover = hold(pool, machine.now(), "box-a", "ws-box-a");
        if (takeover.state !== "held") return;
        give(pool, "box-a", takeover.token, 4);
        const next = claim(pool, machine.now());
        if (next) unhold(pool, "box-a", next.token);
        replacement = next?.claim;
      });
    },
  });
  const code = await startBox(coder, machine, "box-a", poolOn(machine));
  expect(replacement).toBeString();
  expect(calls.filter((call) => call.command.includes("box-claim"))).toEqual([]);
  expect(registryOf(home).boxes["box-a"]).toEqual({ id: "ws-box-a", claim: replacement });
  expect(limits).toEqual([startLimitMs]);
  expect(startLimitMs).toBeLessThan(holdMs);
  expect(code).toBe(1);
  expect(lines.join("\n")).toContain("took box-a over");
});

test("the sweep holds a box from its idle check to its stop, so a release and a new lane in between never see their box stopped", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-old" } } });
  const { machine } = fakeMachine(home, { isHub: true });
  const during: { release?: number; spawn?: string } = {};
  const { coder, done } = fakeCoder({
    ssh: async (_box, command) => {
      if (command.includes("box idle") && !("release" in during)) {
        during.release = await release(coder, machine, "box-lane", { pool: poolOn(machine) });
        const next = await poolOn(machine).claim();
        if (next) await poolOn(machine).unhold(next.box, next.token);
        during.spawn = next?.box;
        return ok;
      }
      return { ...ok, stdout: claimRead(home, "box-lane")(command) };
    },
  });
  expect(await sweep(coder, machine, poolOn(machine))).toBe(0);
  expect(during).toEqual({ release: 1, spawn: undefined });
  expect(done).toEqual(["stop box-lane"]);
  expect(registryOf(home).boxes["box-lane"]).toEqual({ id: "ws-box-lane", claim: "c-old" });
});

test("a sweep whose idle check outlasts its hold stops nothing once another operation took the box over, and lets go of nothing it no longer holds", async () => {
  const home = hubHome();
  writePool(home, { boxes: { "box-lane": { id: "ws-box-lane", claim: "c-old" } } });
  const { machine, lines } = fakeMachine(home, { isHub: true });
  let takeover = "";
  const { coder, done } = fakeCoder({
    ssh: async (_box, command) => {
      if (!command.includes("box idle")) return ok;
      await machine.sleep(holdMs);
      changePoolNow(home, (pool) => {
        const held = hold(pool, machine.now(), "box-lane", "ws-box-lane", "c-old");
        if (held.state === "held") takeover = held.token;
      });
      return ok;
    },
  });
  expect(await sweep(coder, machine, poolOn(machine))).toBe(1);
  expect(done).toEqual([]);
  expect(takeover).not.toBe("");
  expect((registryOf(home).boxes["box-lane"]?.hold as { token: string } | undefined)?.token).toBe(takeover);
  expect(lines.join("\n")).toContain("took box-lane over");
});

test("the sweep leaves a running box that is in the pool to the pool, and keeps a box another operation holds", async () => {
  const home = hubHome();
  writePool(home, { free: ["box-free"], boxes: { "box-free": { id: "ws-box-free" }, "box-held": { id: "ws-box-held", claim: "c-1", hold: { token: "t-other", until: start + holdMs } } } });
  const { machine, lines } = fakeMachine(home, { isHub: true });
  const { coder, calls, done } = fakeCoder({ boxes: async () => [box("box-free"), box("box-held")] });
  expect(await sweep(coder, machine, poolOn(machine))).toBe(0);
  expect(calls).toEqual([]);
  expect(done).toEqual([]);
  expect(pooled(poolFile(home))).toEqual(["box-free"]);
  expect(lines).toEqual(["box-free: in the pool, which stops it; kept", "box-held: the pool refresh, a spawn, a start, a sweep or a release holds it; kept"]);
});
