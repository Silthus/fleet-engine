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

async function startHeavy(extra: Record<string, string>, bin: string, ...args: string[]) {
  const home = temp.make("home-");
  const { FLEET_HEAVY_SLOTS: _, ...inherited } = Bun.env;
  const env = { ...inherited, HOME: home, XDG_RUNTIME_DIR: home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify(roomy), ...extra };
  const child = Bun.spawn(["bun", join(import.meta.dir, "../commands/heavy.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let seen = "";
  while (!seen.includes("ready\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    seen += new TextDecoder().decode(chunk.value);
  }
  return child;
}

const trapsTerm = 'trap "echo stopped > \\"$0\\"; exit 5" TERM; echo ready; while :; do sleep 0.05; done';

onLinux("passes a stop signal on to the heavy-route handler and exits with its code", async () => {
  const { bin } = stubs();
  const stopped = join(bin, "stopped");
  const handler = join(bin, "route.ts");
  writeFileSync(handler, `import { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => { writeFileSync(${JSON.stringify(stopped)}, "stopped\\n"); process.exit(5); });\nconsole.log("ready");\nsetTimeout(() => process.exit(9), 3000);\n`);
  const child = await startHeavy({ FLEET_HANDLERS: JSON.stringify({ "heavy-route": handler }) }, bin, "--", "true");
  child.kill("SIGTERM");
  expect(await child.exited).toBe(5);
  expect(readFileSync(stopped, "utf8")).toBe("stopped\n");
});

onLinux("passes a stop signal on to a command that runs in a slot here", async () => {
  const { bin } = stubs();
  const stopped = join(bin, "stopped");
  const child = await startHeavy({}, bin, "--", "sh", "-c", trapsTerm, stopped);
  child.kill("SIGTERM");
  expect(await child.exited).toBe(5);
  expect(readFileSync(stopped, "utf8")).toBe("stopped\n");
});

async function holdSlot(locks: string, slot: number) {
  mkdirSync(locks, { recursive: true });
  const job = Bun.spawn(["sh", "-c", 'exec 9>"$1"; flock -n 9 && echo locked && exec tail -f /dev/null', "sh", join(locks, `slot-${slot}`)], { stdout: "pipe" });
  await job.stdout.getReader().read();
  return job;
}

onLinux("names the job that holds each slot with its age, frees a slot whose job is gone, and lists live waiting jobs oldest first", async () => {
  const { bin } = stubs();
  const runtime = temp.make("runtime-");
  const locks = join(runtime, "fleet-heavy");
  const job = await holdSlot(locks, 1);
  try {
    const seconds = Math.floor(Date.now() / 1000);
    writeFileSync(join(locks, "slot-1.holder"), `pid=${job.pid}\nstart=${seconds - 125}\nthread=thread-1\ndir=/work/one\ncommand=bun run test\n`);
    writeFileSync(join(locks, "slot-2.holder"), `pid=999999999\nstart=${seconds - 10}\nthread=\ndir=/work/two\ncommand=bun run typecheck\n`);
    writeFileSync(join(locks, `wait-${seconds - 60}-${process.pid}`), `pid=${process.pid}\nstart=${seconds - 60}\nthread=\ndir=/work/three\ncommand=pytest\n`);
    writeFileSync(join(locks, `wait-${seconds - 90}-999999999`), "pid=999999999\n");
    const result = await heavyWith({ XDG_RUNTIME_DIR: runtime }, bin, roomy, "--holders");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe([
      `Fleet heavy slots on ${hostname()}:`,
      `  slot 1: pid ${job.pid}, 2m, thread thread-1, in /work/one: bun run test`,
      "  slot 2: free",
      "Waiting, oldest first:",
      `  pid ${process.pid}, 1m, in /work/three: pytest`,
      "",
    ].join("\n"));
    expect(existsSync(join(locks, "slot-2.holder"))).toBe(false);
    expect(existsSync(join(locks, `wait-${seconds - 90}-999999999`))).toBe(false);
  } finally {
    job.kill();
  }
});

onLinux("names a process that still holds a slot after the job that started it exited", async () => {
  const { bin } = stubs();
  const runtime = temp.make("runtime-");
  const locks = join(runtime, "fleet-heavy");
  const orphan = await holdSlot(locks, 1);
  try {
    writeFileSync(join(locks, "slot-1.holder"), `pid=999999999\nstart=${Math.floor(Date.now() / 1000) - 125}\nthread=\ndir=/work/one\ncommand=bun run test\n`);
    const result = await heavyWith({ XDG_RUNTIME_DIR: runtime, FLEET_HEAVY_SLOTS: "1" }, bin, roomy, "--holders");
    expect(result.stdout).toStartWith(`Fleet heavy slots on ${hostname()}:\n  slot 1: the job exited, but a process it started holds the slot: pid ${orphan.pid}, `);
    expect(result.stdout).toEndWith(`tail -f /dev/null. The job was pid 999999999, 2m, in /work/one: bun run test\nNo job waits.\n`);
  } finally {
    orphan.kill();
  }
});

onLinux("says so when no heavy job ran here yet", async () => {
  const { bin } = stubs();
  expect(await heavyWith({ XDG_RUNTIME_DIR: temp.make("runtime-") }, bin, roomy, "--holders")).toMatchObject({ code: 0, stdout: "Fleet heavy: no job has run here yet.\n" });
});

onLinux("waits behind a job that queued first, even with a free slot, and says its place in the queue", async () => {
  const { bin } = stubs();
  const runtime = temp.make("runtime-");
  const locks = join(runtime, "fleet-heavy");
  mkdirSync(locks);
  const seconds = Math.floor(Date.now() / 1000);
  writeFileSync(join(locks, `wait-${seconds - 60}-${process.pid}`), `pid=${process.pid}\nstart=${seconds - 60}\nthread=\ndir=/work/one\ncommand=pytest\n`);
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 9\n");
  chmodSync(join(bin, "sleep"), 0o755);
  const result = await heavyWith({ XDG_RUNTIME_DIR: runtime, FLEET_HEAVY_SLOTS: "1" }, bin, roomy, "--", "sh", "-c", "echo built");
  expect(result.stdout).toBe("");
  expect(result.stderr).toStartWith("Fleet heavy: waiting for one of 1 slots; this job is number 2 of 2 in the queue and waited 0s so far. The slots:\n  slot 1: free\n");
  expect(readdirSync(locks).filter((name) => name.startsWith("wait-"))).toEqual([`wait-${seconds - 60}-${process.pid}`]);
});
