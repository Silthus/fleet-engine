import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

const realSleep = Bun.which("sleep")!;

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
  writeFileSync(join(bin, "sleep"), `#!/bin/sh\nexec ${realSleep} 0.02\n`);
  chmodSync(join(bin, "sleep"), 0o755);
  const home = temp.make("home-");
  const folder = temp.make("work-");
  const started: Array<ReturnType<typeof Bun.spawn>> = [];
  const { FLEET_HEAVY_SLOTS: _, T3CODE_THREAD_ID: __, ...inherited } = Bun.env;
  const env = (extra: Record<string, string>) => ({ ...inherited, HOME: home, XDG_RUNTIME_DIR: home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify(roomy), FLEET_HEAVY_SLOTS: String(slots), ...extra });
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
    for (const child of started) child.kill("SIGTERM");
    await Promise.all(started.map((child) => child.exited));
  };
  return { bin, folder, start, holders, stopAll };
}

async function gone(pid: number) {
  for (let tries = 0; existsSync(`/proc/${pid}`) && tries < 400; tries++) await Bun.sleep(5);
  return !existsSync(`/proc/${pid}`);
}

const host = () => `Fleet heavy slots on ${hostname()}:\n`;
const age = "\\d+s";

onLinux("passes a stop signal on once to the heavy-route handler, though the whole process group gets it, and exits with its code", async () => {
  const box = machine();
  const seen = join(box.bin, "signals");
  const handler = join(box.bin, "route.ts");
  writeFileSync(handler, `import { appendFileSync } from "node:fs";\nprocess.on("SIGINT", () => { appendFileSync(${JSON.stringify(seen)}, "int\\n"); console.log("got"); });\nprocess.on("SIGTERM", () => process.exit(5));\nconsole.log("ready");\nsetTimeout(() => process.exit(9), 3000);\n`);
  try {
    const job = box.start(["--", "true"], { FLEET_HANDLERS: JSON.stringify({ "heavy-route": handler }) });
    await job.out.until("ready\n");
    process.kill(-job.child.pid, "SIGINT");
    await job.out.until("got\n");
    job.child.kill("SIGTERM");
    expect(await job.child.exited).toBe(5);
    expect(readFileSync(seen, "utf8")).toBe("int\n");
  } finally {
    await box.stopAll();
  }
});

onLinux("stops the command and every process it started on a stop signal, so its slot is free again", async () => {
  const box = machine();
  const pidFile = join(box.bin, "background");
  try {
    const job = box.start(["--", "sh", "-c", 'tail -f /dev/null & echo $! > "$0"; echo ready; wait', pidFile]);
    await job.out.until("ready\n");
    const background = Number(readFileSync(pidFile, "utf8"));
    job.child.kill("SIGTERM");
    await job.child.exited;
    expect(await gone(background)).toBe(true);
    expect(await box.holders()).toBe(`${host()}  slot 1: free\nNo job waits.\n`);
  } finally {
    await box.stopAll();
  }
});

onLinux("lists the job in each slot with its thread, folder and command, and the waiting jobs in the order they came, each with its place", async () => {
  const box = machine();
  try {
    const first = box.start(["--", "sh", "-c", "echo ready; exec tail -f /dev/null"], { T3CODE_THREAD_ID: "thread-1" });
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
    const first = box.start(["--", "sh", "-c", "echo ready; exec tail -f /dev/null"]);
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
    const first = box.start(["--", "sh", "-c", "echo ready; exec tail -f /dev/null"]);
    await first.out.until("ready\n");
    const waiting = box.start(["--", "true"]);
    await waiting.err.until("this job is number 1 of 1 in the queue");
    waiting.child.kill("SIGHUP");
    expect(await waiting.child.exited).toBe(129);
    expect(await box.holders()).toEndWith("No job waits.\n");
  } finally {
    await box.stopAll();
  }
});

onLinux("hands the command no lock from its time in the queue", async () => {
  const box = machine();
  try {
    const first = box.start(["--", "sh", "-c", "echo ready; exec tail -f /dev/null"]);
    await first.out.until("ready\n");
    const queued = box.start(["--", "sh", "-c", 'if [ -e /proc/$$/fd/8 ]; then echo "holds fd 8"; else echo clean; fi']);
    await queued.err.until("this job is number 1 of 1 in the queue");
    process.kill(-first.child.pid, "SIGTERM");
    expect(await queued.child.exited).toBe(0);
    expect(queued.out.text()).toBe("clean\n");
  } finally {
    await box.stopAll();
  }
});

onLinux("says so when no heavy job ran here yet", async () => {
  const box = machine();
  expect(await box.holders()).toBe("Fleet heavy: no job has run here yet.\n");
});
