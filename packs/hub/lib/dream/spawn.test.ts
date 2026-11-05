import { afterEach, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDirs } from "../../../../src/testing/git.ts";
import { boundedSpawn } from "./spawn.ts";

const temp = tempDirs();
const readers: number[] = [];
afterEach(() => {
  for (const reader of readers.splice(0)) try { process.kill(reader, "SIGKILL"); } catch {}
  temp.cleanup();
});

function blockingAnalyst(dir: string) {
  for (const fifo of ["hold", "ready"]) expect(Bun.spawnSync(["mkfifo", join(dir, fifo)]).exitCode).toBe(0);
  const script = join(dir, "analyst");
  writeFileSync(script, `#!/bin/sh\nexec 3<>"${dir}/hold"\ncat <&3 &\necho $! > "${dir}/ready"\nwait\n`);
  chmodSync(script, 0o755);
  return { script, ready: () => readFile(join(dir, "ready"), "utf8") };
}

test("an analyst that outlives its limit is stopped with its whole process group", async () => {
  const dir = temp.make("fleet-dream-spawn-");
  const { script, ready } = blockingAnalyst(dir);
  let fire = () => {};
  const limits: number[] = [];
  const spawn = boundedSpawn((ms, stop) => (limits.push(ms), fire = stop, () => {}));
  const answer = spawn([script], { cwd: dir, env: { PATH: "/usr/bin:/bin" }, stdin: "", timeoutMs: 600_000 });
  readers.push(Number(await ready()));
  expect(readers[0]).toBeGreaterThan(0);
  fire();
  expect(await answer).toEqual({ code: 137, stdout: "", timedOut: true });
  expect(limits).toEqual([600_000]);
}, 2000);

test("an analyst that finishes in time returns its exit code and output, and clears its limit", async () => {
  const dir = temp.make("fleet-dream-spawn-");
  let cleared = 0;
  const spawn = boundedSpawn(() => () => void cleared++);
  expect(await spawn(["/bin/cat"], { cwd: dir, env: { PATH: "/usr/bin:/bin" }, stdin: "hello", timeoutMs: 1000 })).toEqual({ code: 0, stdout: "hello", timedOut: false });
  expect(cleared).toBe(1);
});
