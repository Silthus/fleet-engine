import { afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableSource } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine } from "../../src/testing/packs.ts";
import { nightlyCommand } from "./lib/nightly.ts";

const onLinux = test.skipIf(process.platform !== "linux");
const temp = tempDirs();
afterEach(() => temp.cleanup());

let engine: AvailableSource;
beforeAll(async () => {
  engine = await engineSource();
});

const fakeFleet = `dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
if [ -p "$dir/started" ]; then echo started > "$dir/started"; read -r _ < "$dir/release"; fi
exit "$(cat "$dir/exit-code")"
`;

function machine() {
  const engineRoot = temp.make("engine-");
  writeFileSync(join(engineRoot, "fleet"), fakeFleet);
  writeFileSync(join(engineRoot, "exit-code"), "0");
  const calls = () => (existsSync(join(engineRoot, "calls")) ? readFileSync(join(engineRoot, "calls"), "utf8").trim().split("\n") : []);
  return { home: temp.make("home-"), engineRoot, calls, failWith: (code: number) => writeFileSync(join(engineRoot, "exit-code"), String(code)) };
}

function nightlyArgs(jobId: string) {
  const job = resolveEngine([engine], {}, devbox).jobs.find((item) => item.id === jobId)!;
  expect(job.schedule.every).toBe("1h");
  expect(job.command.slice(0, 2)).toEqual(["fleet", "nightly"]);
  return job.command.slice(2);
}

const hourlyFrom = (start: string, hours: number) => Array.from({ length: hours }, (_, hour) => new Date(Date.parse(start) + hour * 3_600_000));

async function hourlyRuns(jobId: string, start: string, hours: number, fails: (at: Date) => boolean, failure = 3) {
  const box = machine();
  const runs: string[] = [];
  for (const at of hourlyFrom(start, hours)) {
    box.failWith(fails(at) ? failure : 0);
    const before = box.calls().length;
    const code = await nightlyCommand(nightlyArgs(jobId), { home: box.home, engineRoot: box.engineRoot, now: () => at });
    if (box.calls().length > before) runs.push(`${at.toISOString().slice(0, 13)} ${box.calls().at(-1)} exit ${code}`);
  }
  return runs;
}

const fifos = (dir: string) => {
  const paths = { started: join(dir, "started"), release: join(dir, "release") };
  Bun.spawnSync(["mkfifo", paths.started, paths.release]);
  return {
    started: () => new Response(Bun.spawn(["cat", paths.started]).stdout).text(),
    release: () => Bun.spawn(["sh", "-c", `echo > "${paths.release}"`]).exited,
    remove: () => (rmSync(paths.started), rmSync(paths.release)),
  };
};

test("a failed nightly update tries again the next hour, and a success ends the night", async () => {
  const runs = await hourlyRuns("fleet-update", "2026-11-09T12:17:00Z", 48, (at) => at.toISOString().startsWith("2026-11-10T00"));
  expect(runs).toEqual(["2026-11-10T00 update exit 3", "2026-11-10T01 update exit 0", "2026-11-11T00 update exit 0"]);
});

test("an update that keeps failing tries each hour of the night window and stops at its end", async () => {
  const runs = await hourlyRuns("agent-update", "2026-11-10T00:47:00Z", 24, () => true);
  expect(runs.map((line) => line.slice(11, 13))).toEqual(["00", "01", "02", "03", "04", "05"]);
  expect(runs[0]).toEndWith("agent-update exit 3");
});

test("an update that exits 75 counts as failed and tries again the next hour", async () => {
  const runs = await hourlyRuns("fleet-update", "2026-11-10T00:17:00Z", 3, (at) => at.getUTCHours() === 0, 75);
  expect(runs).toEqual(["2026-11-10T00 update exit 1", "2026-11-10T01 update exit 0"]);
});

test("an update whose success cannot be recorded reports a failure", async () => {
  const box = machine();
  mkdirSync(join(box.home, ".local/state/fleet/nightly/fleet-update"), { recursive: true });
  expect(await nightlyCommand(nightlyArgs("fleet-update"), { home: box.home, engineRoot: box.engineRoot, now: () => new Date("2026-11-10T00:17:00Z") })).not.toBe(0);
  expect(box.calls()).toEqual(["update"]);
});

onLinux("an hour that starts while the last update still runs leaves it alone", async () => {
  const box = machine();
  const hold = fifos(box.engineRoot);
  const first = nightlyCommand(nightlyArgs("fleet-update"), { home: box.home, engineRoot: box.engineRoot, now: () => new Date("2026-11-10T00:17:00Z") });
  await hold.started();
  expect(await nightlyCommand(nightlyArgs("fleet-update"), { home: box.home, engineRoot: box.engineRoot, now: () => new Date("2026-11-10T01:17:00Z") })).toBe(0);
  await hold.release();
  expect(await first).toBe(0);
  expect(box.calls()).toEqual(["update"]);
});

onLinux("an update that outlives its killed wrapper keeps the next hour out", async () => {
  const box = machine();
  const hold = fifos(box.engineRoot);
  const driver = join(temp.make("driver-"), "driver.ts");
  writeFileSync(driver, `import { nightlyCommand } from ${JSON.stringify(join(import.meta.dir, "lib/nightly.ts"))};\nawait nightlyCommand(JSON.parse(Bun.argv[2]), { home: Bun.argv[3], engineRoot: Bun.argv[4], now: () => new Date("2026-11-10T00:17:00Z") });\n`);
  const killed = Bun.spawn([process.execPath, driver, JSON.stringify(nightlyArgs("fleet-update")), box.home, box.engineRoot], { stdio: ["ignore", "ignore", "ignore"] });
  await hold.started();
  killed.kill(9);
  await killed.exited;
  expect(await nightlyCommand(nightlyArgs("fleet-update"), { home: box.home, engineRoot: box.engineRoot, now: () => new Date("2026-11-10T01:17:00Z") })).toBe(0);
  expect(box.calls()).toEqual(["update"]);
  await hold.release();
});
