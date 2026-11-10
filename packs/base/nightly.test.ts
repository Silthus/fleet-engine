import { afterEach, beforeAll, expect, test } from "bun:test";
import type { AvailableSource } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine } from "../../src/testing/packs.ts";
import { nightlyCommand } from "./lib/nightly.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

let engine: AvailableSource;
beforeAll(async () => {
  engine = await engineSource();
});

const engineRoot = "/opt/fleet-engine";
const hourlyFrom = (start: string, hours: number) => Array.from({ length: hours }, (_, hour) => new Date(Date.parse(start) + hour * 3_600_000));

async function nightsOf(jobId: string, start: string, hours: number, fails: (at: Date) => boolean) {
  const job = resolveEngine([engine], {}, devbox).jobs.find((item) => item.id === jobId)!;
  expect(job.schedule.every).toBe("1h");
  expect(job.command.slice(0, 2)).toEqual(["fleet", "nightly"]);
  const home = temp.make("home-");
  const runs: string[] = [];
  for (const at of hourlyFrom(start, hours)) {
    const run = async (command: string[]) => (runs.push(`${at.toISOString().slice(0, 13)} ${command.join(" ")}`), fails(at) ? 1 : 0);
    await nightlyCommand(job.command.slice(2), { home, engineRoot, now: () => at, run });
  }
  return runs;
}

test("a failed nightly update tries again the next hour, and a success ends the night", async () => {
  const firstTry = "2026-11-10T00";
  const runs = await nightsOf("fleet-update", "2026-11-09T12:17:00Z", 48, (at) => at.toISOString().startsWith(firstTry));
  const update = `/bin/sh ${engineRoot}/fleet update`;
  expect(runs).toEqual([`2026-11-10T00 ${update}`, `2026-11-10T01 ${update}`, `2026-11-11T00 ${update}`]);
});

test("an update that keeps failing tries each hour of the night window and stops at its end", async () => {
  const runs = await nightsOf("agent-update", "2026-11-10T00:47:00Z", 24, () => true);
  expect(runs.map((line) => line.slice(11, 13))).toEqual(["00", "01", "02", "03", "04", "05"]);
  expect(runs[0]).toEndWith(`/bin/sh ${engineRoot}/fleet agent-update`);
});
