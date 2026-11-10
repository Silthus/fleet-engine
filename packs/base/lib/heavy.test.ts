import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const onLinux = test.skipIf(process.platform !== "linux");

function stubs(os = "Linux") {
  const bin = temp.make("bin-");
  const calls = join(bin, "calls.log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
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
  expect(result.stderr).toContain("Fleet heavy: 1 heavy jobs run already");
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
