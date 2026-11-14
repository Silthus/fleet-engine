import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { heavy, machine, roomy, stubs, temp } from "./heavy-testing.ts";

afterEach(() => temp.cleanup());
const onLinux = test.skipIf(process.platform !== "linux");

const host = () => `Fleet heavy slots on ${hostname()}:\n`;
const age = "\\d+s";
const holdSlot = ["--", "sh", "-c", "echo ready; exec tail -f /dev/null"];

onLinux("frees the slot when a stop reaches the job's process group, with every process the command started", async () => {
  const box = machine();
  try {
    const job = box.start(["--", "sh", "-c", "tail -f /dev/null & echo ready; wait"]);
    await job.out.until("ready\n");
    process.kill(-job.child.pid, "SIGTERM");
    await job.child.exited;
    const next = box.start(["--", "sh", "-c", "echo next"]);
    await next.out.until("next\n");
    expect(await next.child.exited).toBe(0);
  } finally {
    await box.stopAll();
  }
});

const recordsStop = `tail -f /dev/null 9>&- & tail=$!; trap 'kill $tail; echo TERM >> "$0"; exit 143' TERM; echo $$; wait $tail`;

onLinux("runs the job as the fleet heavy process itself, so a stop sent only to that process reaches the job and frees the slot", async () => {
  const box = machine();
  const stops = join(box.home, "stops");
  try {
    const job = box.start(["--", "sh", "-c", recordsStop, stops]);
    await job.out.until("\n");
    expect(job.out.text()).toBe(`${job.child.pid}\n`);
    process.kill(job.child.pid, "SIGTERM");
    expect(await job.child.exited).toBe(143);
    expect(readFileSync(stops, "utf8")).toBe("TERM\n");
    const next = box.start(["--", "sh", "-c", "echo next"]);
    await next.out.until("next\n");
    expect(await next.child.exited).toBe(0);
  } finally {
    await box.stopAll();
  }
});

onLinux("lets a writer in the job end on a closed pipe, as it does outside fleet heavy", async () => {
  const box = machine();
  const job = box.start(["--", "sh", "-c", "(yes; echo $? >&2) | head -n 1"]);
  expect(await job.child.exited).toBe(0);
  await job.err.until("\n");
  expect(job.err.text()).toEndWith("\n141\n");
});

onLinux("runs the job on a Bun that cannot replace its own process, as before", async () => {
  const { bin } = stubs();
  const older = join(bin, "older-bun.ts");
  writeFileSync(older, "delete (process as { execve?: unknown }).execve;\n");
  const home = temp.make("home-");
  const { FLEET_HEAVY_SLOTS: _, ...inherited } = Bun.env;
  const env = { ...inherited, HOME: home, XDG_RUNTIME_DIR: home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify(roomy) };
  const child = Bun.spawn([process.execPath, "--preload", older, join(import.meta.dir, "../commands/heavy.ts"), "--", "sh", "-c", "echo built"], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code: await child.exited, stdout }).toEqual({ code: 0, stdout: "built\n" });
  expect(stderr).not.toContain("cannot run");
});

onLinux("finds sh where the caller has no PATH, as a spawned command does", async () => {
  const { PATH: _, ...withoutPath } = Bun.env;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../commands/heavy.ts"), "--help"], { env: { ...withoutPath, FLEET_SETTINGS: JSON.stringify(roomy) }, stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited).toBe(0);
  expect(stdout).toStartWith("Usage: fleet heavy");
});

onLinux("takes a waiting job off the queue when a stop is sent only to its fleet heavy process", async () => {
  const box = machine();
  try {
    const first = box.start(holdSlot);
    await first.out.until("ready\n");
    const waiting = box.start(["--", "sh", "-c", "echo ran"]);
    await waiting.err.until("this job is number 1 of 1 in the queue");
    process.kill(waiting.child.pid, "SIGTERM");
    expect(await waiting.child.exited).toBe(143);
    expect(await box.holders()).toEndWith("No job waits.\n");
    process.kill(-first.child.pid, "SIGTERM");
    await first.child.exited;
    const next = box.start(["--", "sh", "-c", "echo next"]);
    await next.out.until("next\n");
    expect(waiting.out.text()).toBe("");
  } finally {
    await box.stopAll();
  }
});

onLinux("lists the job in each slot with its thread, folder and command, and the waiting jobs in the order they came, each with its place", async () => {
  const box = machine();
  try {
    const first = box.start(holdSlot, { T3CODE_THREAD_ID: "thread-1" });
    await first.out.until("ready\n");
    const second = box.start(["--", "sh", "-c", "echo second; exec tail -f /dev/null"]);
    await second.err.until("this job is number 1 of 1 in the queue");
    const third = box.start(["--", "true"]);
    await third.err.until("this job is number 2 of 2 in the queue");
    await third.err.until("  slot 1: pid ");
    expect(await box.holders()).toMatch(new RegExp(`^${host()}  slot 1: pid \\d+, ${age}, thread thread-1, in ${box.folder}: sh -c echo ready; exec tail -f /dev/null\nWaiting, oldest first:\n  pid \\d+, ${age}, in ${box.folder}: sh -c echo second; exec tail -f /dev/null\n  pid \\d+, ${age}, in ${box.folder}: true\n$`));
    process.kill(-first.child.pid, "SIGTERM");
    await second.out.until("second\n");
    expect(await box.holders()).toMatch(new RegExp(`^${host()}  slot 1: pid \\d+, ${age}, in ${box.folder}: sh -c echo second; exec tail -f /dev/null\nWaiting, oldest first:\n  pid \\d+, ${age}, in ${box.folder}: true\n$`));
  } finally {
    await box.stopAll();
  }
});

onLinux("names a process that still holds a slot after the job that started it exited", async () => {
  const box = machine();
  const pidFile = join(box.bin, "background");
  let background = 0;
  try {
    const job = box.start(["--", "sh", "-c", 'tail -f /dev/null & echo $! > "$0"', pidFile]);
    expect(await job.child.exited).toBe(0);
    background = Number(readFileSync(pidFile, "utf8"));
    expect(await box.holders()).toMatch(new RegExp(`^${host()}  slot 1: the job exited, but a process it started holds the slot: pid ${background}, ${age}, in ${box.folder}: tail -f /dev/null\\. The job was pid \\d+, ${age}, in ${box.folder}: sh -c tail -f /dev/null & echo \\$! > "\\$0" ${pidFile}\nNo job waits\\.\n$`));
  } finally {
    if (background) process.kill(background, "SIGKILL");
    await box.stopAll();
  }
});

onLinux("forgets a waiting job that died without cleaning up, so the next job takes the free slot", async () => {
  const box = machine();
  try {
    const first = box.start(holdSlot);
    await first.out.until("ready\n");
    const doomed = box.start(["--", "true"]);
    await doomed.err.until("this job is number 1 of 1 in the queue");
    const waiter = Number((await box.holders()).match(/Waiting, oldest first:\n  pid (\d+)/)![1]);
    process.kill(waiter, "SIGKILL");
    await doomed.child.exited;
    process.kill(-first.child.pid, "SIGTERM");
    await first.child.exited;
    const next = box.start(["--", "sh", "-c", "echo next"]);
    await next.out.until("next\n");
    expect(next.err.text()).not.toContain("waiting for one of");
  } finally {
    await box.stopAll();
  }
});

onLinux("keeps its job records where only this user can read them, also without a runtime folder", async () => {
  const box = machine();
  const records = join(box.tmp, `fleet-heavy-${process.getuid!()}`);
  mkdirSync(records, { mode: 0o777 });
  chmodSync(records, 0o777);
  const job = box.start(["--", "sh", "-c", "echo done"], { XDG_RUNTIME_DIR: "" });
  expect(await job.child.exited).toBe(0);
  expect(job.out.text()).toBe("done\n");
  expect(statSync(records).mode & 0o777).toBe(0o700);
  const other = box.start(["--", "sh", "-c", "echo done"]);
  expect(await other.child.exited).toBe(0);
  expect(statSync(join(box.home, "fleet-heavy")).mode & 0o777).toBe(0o700);
});

onLinux("refuses a records folder that is a link, and runs nothing", async () => {
  const box = machine();
  const elsewhere = temp.make("elsewhere-");
  symlinkSync(elsewhere, join(box.home, "fleet-heavy"));
  const job = box.start(["--", "sh", "-c", "echo ran"]);
  expect(await job.child.exited).toBe(1);
  expect(job.out.text()).toBe("");
  expect(job.err.text()).toBe(`Fleet heavy: ${join(box.home, "fleet-heavy")} is not a private folder of this user, so it cannot keep job records there.\n`);
  expect(readdirSync(elsewhere)).toEqual([]);
});

onLinux("says so when no heavy job ran here yet", async () => {
  const box = machine();
  expect(await box.holders()).toBe("Fleet heavy: no job has run here yet.\n");
});
