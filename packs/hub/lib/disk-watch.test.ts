import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { diskWatchCommand, diskWatchTargets, watchDisks, type DiskWatchOptions } from "./disk-watch.ts";
import { underLock } from "./hub-job.ts";
import { quote, remoteFleet } from "./machine.ts";
import { writeHome } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const gigabyte = 1024 ** 3;
const hour = 3600_000;
const start = Date.parse("2026-11-01T00:00:00Z");

function watch(free: Record<string, number[]>, fields: Partial<DiskWatchOptions> = {}) {
  const lines: string[] = [];
  const swept: string[] = [];
  const alerts: string[] = [];
  let now = start;
  const reads = Object.fromEntries(Object.entries(free).map(([box, values]) => [box, [...values]]));
  const options: DiskWatchOptions = {
    boxes: Object.keys(free), statePath: join(temp.make("disk-watch-"), "state.json"), now: () => now, log: (line) => lines.push(line),
    sweepBelowGigabytes: 15, alertBelowGigabytes: 10,
    read: async (box) => (reads[box]!.length > 1 ? reads[box]!.shift()! : reads[box]![0]!) * gigabyte,
    sweep: async (box) => (swept.push(box), Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n")),
    alert: async (box, bytes, report) => (alerts.push(`${box} ${(bytes / gigabyte).toFixed(1)} ${report.split("\n")[0]}`), true),
    ...fields,
  };
  return { options, lines, swept, alerts, advance: (ms: number) => void (now += ms) };
}

test("a box with room needs nothing, a low box is swept, and only a box still under the alert floor after the sweep alerts", async () => {
  const run = watch({ "box-1": [40], "box-2": [12, 30], "box-3": [12, 6] });
  await watchDisks(run.options);
  expect(run.swept.sort()).toEqual(["box-2", "box-3"]);
  expect(run.alerts).toEqual(["box-3 6.0 line 11"]);
  expect(run.lines).toContain("box-1: 40.0G free");
  expect(run.lines).toContain("box-2: 30.0G free after the sweep");
  expect(run.lines).toContain("box-3: alerted");
});

test("a box is swept at most once an hour and alerted at most once a day, and climbing above the sweep floor resets both", async () => {
  const run = watch({ "box-3": [6] });
  await watchDisks(run.options);
  run.advance(hour / 2);
  await watchDisks(run.options);
  expect(run.swept).toEqual(["box-3"]);
  expect(run.lines.slice(-2)).toEqual(["box-3: 6.0G free; swept already", "box-3: alerted already"]);
  run.advance(hour);
  await watchDisks(run.options);
  expect([run.swept.length, run.alerts.length]).toEqual([2, 1]);
  run.advance(24 * hour);
  await watchDisks(run.options);
  expect(run.alerts.length).toBe(2);
  const high = watch({ "box-3": [6] }, { statePath: run.options.statePath, now: run.options.now });
  high.options.read = async () => 40 * gigabyte;
  await watchDisks(high.options);
  expect(JSON.parse(readFileSync(run.options.statePath, "utf8"))).toEqual({});
});

test("a box that climbs back above the sweep floor after its sweep resets both limits, so the next incident is swept and alerted again", async () => {
  const run = watch({ "box-3": [4, 30, 4, 6] });
  writeFileSync(run.options.statePath, JSON.stringify({ "box-3": { sweptAt: start - 2 * hour, alertedAt: start - 2 * hour } }));
  await watchDisks(run.options);
  expect(run.swept).toEqual(["box-3"]);
  expect(JSON.parse(readFileSync(run.options.statePath, "utf8"))).toEqual({});
  run.advance(hour / 4);
  await watchDisks(run.options);
  expect([run.swept, run.alerts]).toEqual([["box-3", "box-3"], ["box-3 6.0 line 11"]]);
});

test("an alert that may have started a thread counts against the daily limit, even when its launch reports failure", async () => {
  let threads = 0;
  const run = watch({ "box-3": [6] }, { alert: async () => (threads++, false) });
  await watchDisks(run.options);
  run.advance(2 * hour);
  await watchDisks(run.options);
  expect(threads).toBe(1);
  expect(run.lines).toContain("box-3: alert failed or lost its answer, so it is not tried again today");
  expect(run.lines.at(-1)).toBe("box-3: alerted already");
  expect(JSON.parse(readFileSync(run.options.statePath, "utf8"))["box-3"].alertedAt).toBe(start);
});

test("a pass that dies during one box's alert keeps the alert it began there and the one it finished on another box", async () => {
  let threads = 0;
  const crashed = watch({ "box-3": [6], "box-4": [6] }, { alert: async (box) => { threads++; if (box === "box-4") throw new Error("killed"); return true; } });
  await expect(watchDisks(crashed.options)).rejects.toThrow("killed");
  const after = watch({ "box-3": [6], "box-4": [6] }, { statePath: crashed.options.statePath, alert: async () => (threads++, true) });
  after.advance(2 * hour);
  await watchDisks(after.options);
  expect(threads).toBe(2);
  expect(after.lines.filter((line) => line.endsWith("alerted already")).sort()).toEqual(["box-3: alerted already", "box-4: alerted already"]);
});

test("a box that does not answer is logged, and a dry run sweeps, alerts, and saves nothing", async () => {
  const run = watch({ "box-1": [6] }, { dryRun: true });
  run.options.boxes = ["box-1", "box-gone"];
  const read = run.options.read;
  run.options.read = async (box) => (box === "box-gone" ? null : read(box));
  await watchDisks(run.options);
  expect([run.swept, run.alerts]).toEqual([[], []]);
  expect(run.lines.sort()).toEqual(["box-1: 6.0G free; would sweep", "box-1: would alert", "box-gone: unreachable"]);
  expect(existsSync(run.options.statePath)).toBe(false);
});

test("each pass leaves the free space of every box that answered next to its state, for fleet disk --start", async () => {
  const run = watch({ "box-1": [40], "box-2": [12, 30] });
  run.options.boxes = ["box-1", "box-2", "box-gone"];
  const read = run.options.read;
  run.options.read = async (box) => (box === "box-gone" ? null : read(box));
  await watchDisks(run.options);
  const map = JSON.parse(readFileSync(join(run.options.statePath, "../disk-free.json"), "utf8"));
  expect(map).toEqual({ checkedAt: new Date(start).toISOString(), boxes: { "box-1": 40 * gigabyte, "box-2": 30 * gigabyte } });
});

test("the targets are the hub here plus the devboxes of the profile and of machine.json, once each and without this machine", () => {
  const home = temp.make("disk-home-");
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub", devboxes: ["box-3", "box-1", "my-hub"] }) });
  const profile = temp.make("disk-profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ devboxes: ["box-1", "box-2", "hub-host"] }));
  expect(diskWatchTargets({ FLEET_PROFILE_DIR: profile }, home, "my-hub", "hub-host")).toEqual({ local: "my-hub", remote: ["box-1", "box-2", "box-3"] });
});

function stubs(dir: string) {
  mkdirSync(dir, { recursive: true });
  const script = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  script("ssh", `echo "ssh $*" >> "${dir}/calls.log"
host=$5
case "$6" in
  *"df -Pk"*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/root 100 50 %s 50%% /\\n' "$(cat "${dir}/free-$host")" ;;
  *disk-sweep*) printf 'swept %s\n30.0G /home/%s/.cache\n' "$host" "$host"; cp "${dir}/after-$host" "${dir}/free-$host" ;;
esac`);
  script("t3", `echo "t3 $*" >> "${dir}/calls.log"\ncat > "${dir}/prompt.txt"`);
  return dir;
}

async function hubHere(devboxes: Record<string, [number, number]>) {
  const home = temp.make("disk-hub-");
  const bin = stubs(join(home, "bin"));
  for (const [box, [before, after]] of Object.entries(devboxes)) {
    writeFileSync(join(bin, `free-${box}`), String(before * 1024 * 1024));
    writeFileSync(join(bin, `after-${box}`), String(after * 1024 * 1024));
  }
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub", devboxes: Object.keys(devboxes) }) });
  const engine = join(home, "engine");
  writeHome(home, { "engine/fleet": `echo "local $*" >> "${bin}/calls.log"` });
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, FLEET_ENGINE_DIR: engine,
    FLEET_SETTINGS: JSON.stringify({ "hub.alias": "my-hub", "hub.diskSweepGigabytes": 15, "hub.diskAlertGigabytes": 10, "hub.threadFolder": "~/notes" }),
    FLEET_MODELS: JSON.stringify([{ role: "lookup", work: "Lookups", provider: "claude", model: "small-model", effort: "medium" }]),
  };
  const lines: string[] = [];
  const context = { home, env, self: "hub-host", now: () => start, log: (line: string) => lines.push(line), localFree: () => 40 * gigabyte };
  const calls = () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n") : []);
  return { home, bin, context, lines, calls };
}

test("on the hub, fleet disk-watch reads each devbox over SSH, sweeps it with the engine launcher, and starts a T3 thread for the one still low", async () => {
  const hub = await hubHere({ "box-1": [12, 30], "box-2": [12, 4] });
  expect(await diskWatchCommand([], hub.context)).toBe(0);
  const calls = hub.calls();
  expect(calls).toContain(`ssh -o BatchMode=yes -o ConnectTimeout=10 box-1 bash -lc ${quote(remoteFleet("disk-sweep --floor 15 --alert-floor 10"))} 2>&1`);
  expect(calls.filter((call) => call.startsWith("t3 "))).toEqual([`t3 project add ${join(hub.home, "notes")}`, "t3 thread start --title box-2: 4.0G free --provider claudeAgent --model small-model /tmp/notes -".replace("/tmp/notes", join(hub.home, "notes"))]);
  const prompt = readFileSync(join(hub.bin, "prompt.txt"), "utf8");
  expect(prompt).toContain("box-2 has 4.0G free, below 10G");
  expect(prompt).toContain("swept box-2\n30.0G /home/box-2/.cache");
  expect(prompt).toContain("the largest folders the report names");
  expect(prompt).toContain(`ssh box-2 ${quote(`bash -lc ${quote(`df -h ~; ${remoteFleet("prune --dry-run --no-fetch --min-idle-hours 1")}`)}`)}`);
  expect(calls.some((call) => call.startsWith("local"))).toBe(false);
});

test("a devbox sweep runs in a login shell, so the engine launcher finds the Bun that only the login profile puts on PATH", async () => {
  const hub = await hubHere({ "box-1": [12, 30] });
  const remote = temp.make("disk-remote-");
  writeHome(remote, {
    ".profile": 'PATH="$HOME/.bun/bin:$PATH"\n',
    ".bun/bin/bun": `echo "bun $*" >> "${hub.bin}/calls.log"`,
    ".local/share/fleet/engine/fleet": readFileSync(join(import.meta.dir, "../../../fleet"), "utf8"),
  });
  chmodSync(join(remote, ".bun/bin/bun"), 0o755);
  writeFileSync(join(hub.bin, "ssh"), `#!/bin/sh
case "$6" in
  *"df -Pk"*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/root 100 50 %s 50%% /\\n' "$(cat "${hub.bin}/free-$5")" ;;
  *) env -i HOME="${remote}" PATH=/usr/bin:/bin /bin/sh -c "$6"; code=$?; cp "${hub.bin}/after-$5" "${hub.bin}/free-$5"; exit $code ;;
esac
`);
  expect(await diskWatchCommand([], hub.context)).toBe(0);
  expect(hub.calls()).toEqual([`bun ${join(remote, ".local/share/fleet/engine/src/cli.ts")} disk-sweep --floor 15 --alert-floor 10`]);
  expect(hub.lines.join("\n")).not.toContain("failed");
});

test("the hub sweeps its own disk with its own launcher, without SSH", async () => {
  const hub = await hubHere({});
  hub.context.localFree = () => 8 * gigabyte;
  expect(await diskWatchCommand([], hub.context)).toBe(0);
  expect(hub.calls()).toEqual(["local disk-sweep --floor 15 --alert-floor 10", `t3 project add ${join(hub.home, "notes")}`, "t3 thread start --title my-hub: 8.0G free --provider claudeAgent --model small-model " + join(hub.home, "notes") + " -"]);
});

test("a second disk watch while one runs does nothing, so the same machine is not alerted twice, and the next one after it ends runs", async () => {
  const hub = await hubHere({ "box-2": [4, 4] });
  expect(await underLock(hub.context, "disk-watch", "The disk watch", () => diskWatchCommand([], hub.context))).toBe(0);
  expect(hub.calls()).toEqual([]);
  expect(hub.lines).toEqual(["The disk watch is already running, so this run ends."]);
  expect(await diskWatchCommand([], hub.context)).toBe(0);
  expect(hub.calls().filter((call) => call.startsWith("t3 thread")).length).toBe(1);
  expect(await diskWatchCommand([], hub.context)).toBe(0);
  expect(hub.calls().filter((call) => call.startsWith("t3 thread")).length).toBe(1);
});

test("fleet disk-watch runs only on the hub and takes only --dry-run", async () => {
  const hub = await hubHere({ "box-2": [4, 4] });
  writeHome(hub.home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "devbox" }) });
  await expect(diskWatchCommand([], hub.context)).rejects.toThrow("fleet disk-watch runs only on the hub. This machine's role is devbox.");
  await expect(diskWatchCommand(["--now"], hub.context)).rejects.toThrow("Usage: fleet disk-watch [--dry-run]");
});
