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

onLinux("refuses a slot count that is not a whole number above 0", async () => {
  const { bin, calls } = stubs();
  for (const slots of [0, -1, 1.5]) {
    const result = await heavy(bin, { ...roomy, "base.heavySlots": slots }, "--", "true");
    expect(result).toMatchObject({ code: 2, stderr: `Fleet heavy: base.heavySlots must be a whole number above 0, not '${slots}'.\n` });
  }
  expect(calls()).toBe("uname -s\nuname -s\nuname -s\n");
});
