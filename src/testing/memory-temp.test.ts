import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./git.ts";
import { memoryTemp } from "./memory-temp.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const deadPid = () => {
  const child = Bun.spawnSync(["true"]);
  return child.pid;
};

test("points TMPDIR at a folder of this worker under the memory root", () => {
  const memory = temp.make("memory-");
  const env: Record<string, string | undefined> = {};
  const dir = memoryTemp(env, { memory, pid: process.pid });
  expect(env.TMPDIR).toBe(dir!);
  expect(dir!.startsWith(memory)).toBe(true);
  writeFileSync(join(dir!, "probe"), "");
  expect(memoryTemp({}, { memory, pid: process.pid })).toBe(dir!);
  expect(existsSync(join(dir!, "probe"))).toBe(true);
});

test("removes what a worker that has ended left behind, and keeps the folders of running workers", () => {
  const memory = temp.make("memory-");
  const ended = memoryTemp({}, { memory, pid: deadPid() })!;
  writeFileSync(join(ended, "leftover"), "");
  const running = memoryTemp({}, { memory, pid: process.ppid })!;
  writeFileSync(join(running, "in-use"), "");
  memoryTemp({}, { memory, pid: process.pid });
  expect(existsSync(ended)).toBe(false);
  expect(existsSync(join(running, "in-use"))).toBe(true);
});

test("leaves TMPDIR alone where the memory root has too little room", () => {
  const memory = temp.make("memory-");
  const env: Record<string, string | undefined> = {};
  expect(memoryTemp(env, { memory, pid: process.pid, room: Number.MAX_SAFE_INTEGER })).toBeUndefined();
  expect(env).toEqual({});
});

test("leaves TMPDIR alone where there is no memory root", () => {
  const env: Record<string, string | undefined> = {};
  expect(memoryTemp(env, { memory: join(temp.make("memory-"), "absent"), pid: process.pid })).toBeUndefined();
  expect(env).toEqual({});
});

test.skipIf(process.getuid?.() === 0)("leaves TMPDIR alone where the memory root cannot be written, as in a sandbox", () => {
  const memory = temp.make("memory-");
  mkdirSync(join(memory, "locked"));
  chmodSync(join(memory, "locked"), 0o500);
  const env: Record<string, string | undefined> = {};
  try {
    expect(memoryTemp(env, { memory: join(memory, "locked"), pid: process.pid })).toBeUndefined();
    expect(env).toEqual({});
  } finally {
    chmodSync(join(memory, "locked"), 0o700);
  }
});
