import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { diskWatchCommand, diskWatchTargets, watchDisks, type DiskWatchOptions } from "./disk-watch.ts";
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
  *disk-sweep*) echo "swept $host"; cp "${dir}/after-$host" "${dir}/free-$host" ;;
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
  expect(calls).toContain(`ssh -o BatchMode=yes -o ConnectTimeout=10 box-1 sh "$HOME/.local/share/fleet/engine/fleet" disk-sweep 2>&1`);
  expect(calls.filter((call) => call.startsWith("t3 "))).toEqual(["t3 thread start --title box-2: 4.0G free --model small-model /tmp/notes -".replace("/tmp/notes", join(hub.home, "notes"))]);
  const prompt = readFileSync(join(hub.bin, "prompt.txt"), "utf8");
  expect(prompt).toContain("box-2 has 4.0G free, below 10G");
  expect(prompt).toContain("swept box-2");
  expect(prompt).toContain(`ssh box-2 'df -h ~; sh "$HOME/.local/share/fleet/engine/fleet" prune --dry-run --no-fetch --min-idle-hours 1'`);
  expect(calls.some((call) => call.startsWith("local"))).toBe(false);
});

test("the hub sweeps its own disk with its own launcher, without SSH", async () => {
  const hub = await hubHere({});
  hub.context.localFree = () => 8 * gigabyte;
  expect(await diskWatchCommand([], hub.context)).toBe(0);
  expect(hub.calls()).toEqual(["local disk-sweep", "t3 thread start --title my-hub: 8.0G free --model small-model " + join(hub.home, "notes") + " -"]);
});

test("a second disk watch that finds the lock of a running one does nothing, so the same machine is not alerted twice; a dead run's lock is taken over", async () => {
  const hub = await hubHere({ "box-2": [4, 4] });
  writeHome(hub.home, { ".local/state/fleet/disk-watch.lock/pid": String(process.pid) });
  expect(await diskWatchCommand([], hub.context)).toBe(0);
  expect(hub.calls()).toEqual([]);
  expect(hub.lines).toEqual(["Another disk watch runs, so this one ends."]);
  writeHome(hub.home, { ".local/state/fleet/disk-watch.lock/pid": String(2 ** 22 + 1) });
  expect(await diskWatchCommand([], hub.context)).toBe(0);
  expect(hub.calls().filter((call) => call.startsWith("t3 ")).length).toBe(1);
  expect(existsSync(join(hub.home, ".local/state/fleet/disk-watch.lock"))).toBe(false);
  expect(await diskWatchCommand([], hub.context)).toBe(0);
  expect(hub.calls().filter((call) => call.startsWith("t3 ")).length).toBe(1);
});

test("fleet disk-watch runs only on the hub and takes only --dry-run", async () => {
  const hub = await hubHere({ "box-2": [4, 4] });
  writeHome(hub.home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "devbox" }) });
  await expect(diskWatchCommand([], hub.context)).rejects.toThrow("fleet disk-watch runs only on the hub. This machine's role is devbox.");
  await expect(diskWatchCommand(["--now"], hub.context)).rejects.toThrow("Usage: fleet disk-watch [--dry-run]");
});
