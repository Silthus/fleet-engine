import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./git.ts";
import { memoryTemp } from "./memory-temp.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const rootOf = (memory: string) => join(memory, `fleet-test-${process.getuid!()}`);

const mountsWith = (memory: string, options: string) => {
  const mounts = join(temp.make("mounts-"), "mounts");
  writeFileSync(mounts, `/dev/root / ext4 rw,relatime 0 0\ntmpfs ${memory} tmpfs ${options} 0 0\n`);
  return mounts;
};

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

test("still removes what ended workers left behind where the memory root has too little room", () => {
  const memory = temp.make("memory-");
  const ended = memoryTemp({}, { memory, pid: deadPid() })!;
  memoryTemp({}, { memory, pid: process.pid, room: Number.MAX_SAFE_INTEGER });
  expect(existsSync(ended)).toBe(false);
});

test("leaves TMPDIR alone where the memory root is mounted noexec, since tests run the tools they write there", () => {
  const memory = temp.make("memory-");
  const env: Record<string, string | undefined> = {};
  expect(memoryTemp(env, { memory, pid: process.pid, mounts: mountsWith(memory, "rw,nosuid,nodev,noexec") })).toBeUndefined();
  expect(env).toEqual({});
  expect(memoryTemp(env, { memory, pid: process.pid, mounts: mountsWith(memory, "rw,nosuid,nodev") })).toBe(env.TMPDIR!);
});

test("leaves TMPDIR alone, and follows nothing, where the folder for this user is a link someone planted", () => {
  const memory = temp.make("memory-");
  const elsewhere = temp.make("elsewhere-");
  const ended = String(deadPid());
  writeFileSync(join(elsewhere, ended), "kept");
  symlinkSync(elsewhere, rootOf(memory));
  const env: Record<string, string | undefined> = {};
  expect(memoryTemp(env, { memory, pid: process.pid })).toBeUndefined();
  expect(env).toEqual({});
  expect(readdirSync(elsewhere)).toEqual([ended]);
});

test("leaves TMPDIR alone where others can write to the folder for this user", () => {
  const memory = temp.make("memory-");
  mkdirSync(rootOf(memory));
  chmodSync(rootOf(memory), 0o777);
  const env: Record<string, string | undefined> = {};
  expect(memoryTemp(env, { memory, pid: process.pid })).toBeUndefined();
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
