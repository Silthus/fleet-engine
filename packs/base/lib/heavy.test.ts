import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const onLinux = test.skipIf(process.platform !== "linux");

const systemdRun = `const args = Bun.argv.slice(2);
const split = args.indexOf("--");
const setenv = args.slice(0, split).filter((option) => option.startsWith("--setenv=")).map((option) => option.slice("--setenv=".length));
const given = Object.fromEntries(setenv.map((pair) => (pair.includes("=") ? [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] : [pair, Bun.env[pair] ?? ""])));
const manager = { HOME: "/home/manager", PATH: "/usr/bin:/bin" };
const env = args.includes("--scope") ? Bun.env : { ...manager, ...given };
process.exit(Bun.spawnSync(args.slice(split + 1), { env, stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1);
`;

function stubs(os = "Linux") {
  const bin = temp.make("bin-");
  const calls = join(bin, "calls.log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  writeFileSync(join(bin, "systemd-run.ts"), systemdRun);
  stub("systemd-run", `case " $* " in *" --scope "*) while [ "$1" != -- ]; do shift; done; shift; exec "$@" ;; esac\nexec bun "${join(bin, "systemd-run.ts")}" "$@"`);
  stub("systemctl", "exit 0");
  stub("uname", `echo ${os}`);
  return { bin, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : "") };
}

async function heavy(bin: string, settings: Record<string, unknown>, ...args: string[]) {
  return heavyWith({}, bin, settings, ...args);
}

async function heavyWith(extra: Record<string, string>, bin: string, settings: Record<string, unknown>, ...args: string[]) {
  const home = temp.make("home-");
  const { FLEET_HEAVY_SLOTS: _, ...inherited } = Bun.env;
  const env = { ...inherited, HOME: home, XDG_RUNTIME_DIR: home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify(settings), ...extra };
  const child = Bun.spawn(["bun", join(import.meta.dir, "../commands/heavy.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

const roomy = { "base.heavySlots": 2, "base.diskFloorGigabytes": 0 };

onLinux("runs the command in a slot of the capped heavy slice", async () => {
  const { bin, calls } = stubs();
  expect(await heavy(bin, roomy, "--", "sh", "-c", "echo built")).toMatchObject({ code: 0, stdout: "built\n" });
  expect(calls()).toBe("uname -s\nsystemd-run --user --scope --quiet --collect --slice=fleet-heavy.slice -- sh -c echo built\n");
});

onLinux("runs a leading fleet in the command with this engine's launcher, though no fleet is on PATH", async () => {
  const { bin } = stubs();
  const slot = await heavy(bin, roomy, "--", "fleet", "help");
  expect(slot.code).toBe(0);
  expect(slot.stdout).toStartWith("Fleet: one setup");
  const served = await heavy(bin, roomy, "--service", "preview-a", "--", "fleet", "help");
  expect(served.stdout).toStartWith("Fleet: one setup");
});

onLinux("gives a service this shell's PATH, HOME, Fleet profile, memory, and XDG folders, though the systemd user manager starts it with its own environment", async () => {
  const { bin } = stubs();
  const profile = temp.make("profile-");
  const folders = { FLEET_PROFILE_DIR: profile, FLEET_MEMORY_DIR: `${profile}/memory`, XDG_STATE_HOME: `${profile}/state`, XDG_CONFIG_HOME: `${profile}/config` };
  const served = await heavyWith(folders, bin, roomy, "--service", "preview-a", "--", "sh", "-c", 'command -v bun >/dev/null && echo "$HOME" "$FLEET_PROFILE_DIR" "$FLEET_MEMORY_DIR" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME"');
  expect(served.stdout).toMatch(new RegExp(`^/\\S*home-\\S+ ${Object.values(folders).join(" ")}\n`));
});

onLinux("refuses to start while the disk is under the floor", async () => {
  const { bin, calls } = stubs();
  const result = await heavy(bin, { ...roomy, "base.diskFloorGigabytes": 1e9 }, "--", "sh", "-c", "echo built");
  expect(result).toMatchObject({ code: 75, stdout: "" });
  expect(result.stderr).toStartWith("Disk is critical: ");
  expect(calls()).toBe("");
});

onLinux("runs the command directly where there is no systemd", async () => {
  const { bin, calls } = stubs("Darwin");
  expect(await heavy(bin, roomy, "--", "sh", "-c", "echo built")).toMatchObject({ code: 0, stdout: "built\n" });
  expect(calls()).toBe("uname -s\n");
});

onLinux("stops a named unit, and refuses a unit name that is not plain", async () => {
  const { bin, calls } = stubs();
  expect((await heavy(bin, roomy, "--stop", "preview-a")).code).toBe(0);
  expect(calls()).toBe("systemctl --user stop preview-a\n");
  expect(await heavy(bin, roomy, "--unit", "a;b", "--", "true")).toMatchObject({ code: 2, stderr: "Fleet heavy: invalid unit name 'a;b'.\n" });
  expect(await heavy(bin, roomy)).toMatchObject({ code: 2, stderr: expect.stringMatching(/^Usage: fleet heavy/) });
});

onLinux("takes the slot count from FLEET_HEAVY_SLOTS over the setting", async () => {
  const { bin } = stubs();
  const held = temp.make("locks-");
  const env = { XDG_RUNTIME_DIR: held, FLEET_HEAVY_SLOTS: "1" };
  const busy = Bun.spawn(["sh", "-c", `mkdir -p ${held}/fleet-heavy; exec 9>${held}/fleet-heavy/slot-1; flock 9; echo locked; exec tail -f /dev/null`], { stdout: "pipe" });
  const reader = busy.stdout.getReader();
  await reader.read();
  const sleeper = join(bin, "sleep");
  writeFileSync(sleeper, "#!/bin/sh\nexit 9\n");
  chmodSync(sleeper, 0o755);
  const result = await heavyWith(env, bin, roomy, "--", "true");
  busy.kill();
  expect(result.stderr).toContain("this job is number 1 of 1 in the queue");
});

function routeHandler(bin: string) {
  const handler = join(bin, "route.ts");
  const seen = join(bin, "routed.log");
  writeFileSync(handler, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: Bun.argv.slice(2), routed: Bun.env.FLEET_HEAVY_ROUTED }) + "\\n");\nprocess.exit(7);\n`);
  return { handlers: JSON.stringify({ "heavy-route": handler }), routed: () => (existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []) };
}

onLinux("hands a typed heavy command to the heavy-route handler, which decides where it runs", async () => {
  const { bin, calls } = stubs();
  const { handlers, routed } = routeHandler(bin);
  expect(await heavyWith({ FLEET_HANDLERS: handlers }, bin, roomy, "--", "sh", "-c", "echo built")).toMatchObject({ code: 7, stdout: "" });
  expect(routed()).toEqual([{ argv: ["sh", "-c", "echo built"], routed: "1" }]);
  expect(calls()).toBe("");
});

onLinux("runs here when the handler already routed the command, or for a named unit or service, and the command routes its own heavy runs again", async () => {
  const { bin, calls } = stubs();
  const { handlers, routed } = routeHandler(bin);
  expect(await heavyWith({ FLEET_HANDLERS: handlers, FLEET_HEAVY_ROUTED: "1" }, bin, roomy, "--", "sh", "-c", "echo built ${FLEET_HEAVY_ROUTED:-unrouted}")).toMatchObject({ code: 0, stdout: "built unrouted\n" });
  expect(await heavyWith({ FLEET_HANDLERS: handlers }, bin, roomy, "--unit", "lane-a", "--", "true")).toMatchObject({ code: 0 });
  expect(await heavyWith({ FLEET_HANDLERS: handlers }, bin, roomy, "--service", "preview-a", "--", "true")).toMatchObject({ code: 0 });
  expect(routed()).toEqual([]);
  expect(calls()).toContain("--unit=lane-a");
  expect(calls()).toContain("--unit=preview-a");
});

onLinux("refuses a slot count that is not a whole number above 0", async () => {
  const { bin, calls } = stubs();
  for (const slots of [0, -1, 1.5]) {
    const result = await heavy(bin, { ...roomy, "base.heavySlots": slots }, "--", "true");
    expect(result).toMatchObject({ code: 2, stderr: `Fleet heavy: base.heavySlots must be a whole number above 0, not '${slots}'.\n` });
  }
  expect(calls()).toBe("uname -s\nuname -s\nuname -s\n");
});

function follow(stream: ReadableStream<Uint8Array>) {
  let text = "";
  let ended = false;
  const waiting: Array<() => void> = [];
  const wake = () => waiting.splice(0).forEach((resume) => resume());
  void (async () => {
    for await (const chunk of stream) {
      text += new TextDecoder().decode(chunk);
      wake();
    }
    ended = true;
    wake();
  })();
  return {
    text: () => text,
    until: async (part: string) => {
      while (!text.includes(part)) {
        if (ended) throw new Error(`the stream ended before "${part}": ${text}`);
        await new Promise<void>((resume) => waiting.push(resume));
      }
    },
  };
}

function machine(slots = 1) {
  const { bin } = stubs();
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "sleep"), 0o755);
  const home = temp.make("home-");
  const tmp = temp.make("tmp-");
  const folder = temp.make("work-");
  const started: Array<ReturnType<typeof Bun.spawn>> = [];
  const { FLEET_HEAVY_SLOTS: _, T3CODE_THREAD_ID: __, ...inherited } = Bun.env;
  const env = (extra: Record<string, string>) => ({ ...inherited, HOME: home, XDG_RUNTIME_DIR: home, TMPDIR: tmp, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify(roomy), FLEET_HEAVY_SLOTS: String(slots), ...extra });
  const start = (args: string[], extra: Record<string, string> = {}) => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "../commands/heavy.ts"), ...args], { cwd: folder, env: env(extra), stdout: "pipe", stderr: "pipe", detached: true });
    started.push(child);
    return { child, out: follow(child.stdout), err: follow(child.stderr) };
  };
  const holders = async () => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "../commands/heavy.ts"), "--holders"], { cwd: folder, env: env({}), stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return stdout;
  };
  const stopAll = async () => {
    for (const child of started) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    await Promise.all(started.map((child) => child.exited));
  };
  return { bin, home, tmp, folder, start, holders, stopAll };
}

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
  const child = Bun.spawn(["bun", "--preload", older, join(import.meta.dir, "../commands/heavy.ts"), "--", "sh", "-c", "echo built"], { env, stdout: "pipe", stderr: "pipe" });
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

onLinux("takes a waiting job off the queue when its terminal hangs up", async () => {
  const box = machine();
  try {
    const first = box.start(holdSlot);
    await first.out.until("ready\n");
    const waiting = box.start(["--", "true"]);
    await waiting.err.until("this job is number 1 of 1 in the queue");
    process.kill(-waiting.child.pid, "SIGHUP");
    await waiting.child.exited;
    expect(await box.holders()).toEndWith("No job waits.\n");
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
