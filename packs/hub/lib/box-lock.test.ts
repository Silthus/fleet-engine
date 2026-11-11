import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { LockBusy, boxLocks, lockBox, withBoxLock } from "./box-lock.ts";
import { capture, orphanGraceSeconds } from "./coder.ts";
import { appeared } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const helper = join(import.meta.dir, "box-lock.ts");
const coderHelper = join(import.meta.dir, "coder.ts");

function holderIn(home: string, box: string) {
  const code = `const { withBoxLock } = await import(${JSON.stringify(helper)});
await withBoxLock(${JSON.stringify(home)}, ${JSON.stringify(box)}, { waitMs: 0 }, async () => {
  console.log("locked");
  await Bun.stdin.text();
});`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const ready = (async () => {
    let seen = "";
    while (!seen.includes("locked\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the holder ended before it locked: ${seen}`);
      seen += new TextDecoder().decode(value);
    }
  })();
  return { child, ready };
}

test("an operation that holds a box's lock in one process makes an operation in another process skip the box, or wait for it", async () => {
  const home = temp.make("fleet-lock-");
  const holder = holderIn(home, "box-a");
  await holder.ready;
  const ran: string[] = [];
  await expect(withBoxLock(home, "box-a", { waitMs: 0 }, async () => void ran.push("skipped one ran"))).rejects.toThrow(new LockBusy("box-a is busy: another fleet box operation on it still runs. Try again in a few minutes."));
  expect(await withBoxLock(home, "box-b", { waitMs: 0 }, async () => "another box is free")).toBe("another box is free");
  const waited = withBoxLock(home, "box-a", {
    waitMs: 60_000,
    waiting: () => {
      ran.push("waiting");
      holder.child.stdin.end();
    },
  }, async () => {
    ran.push(`ran after the holder ended with ${await holder.child.exited}`);
    return "waited";
  });
  expect(await waited).toBe("waited");
  expect(ran).toEqual(["waiting", "ran after the holder ended with 0"]);
});

test("a crashed operation lets go of its lock by dying, so the next operation on the box runs", async () => {
  const home = temp.make("fleet-lock-");
  const holder = holderIn(home, "box-a");
  await holder.ready;
  await expect(withBoxLock(home, "box-a", { waitMs: 0 }, async () => 1)).rejects.toBeInstanceOf(LockBusy);
  holder.child.kill("SIGKILL");
  expect(await holder.child.exited).not.toBe(0);
  expect(await withBoxLock(home, "box-a", { waitMs: 0 }, async () => "ran")).toBe("ran");
});

function stub(dir: string, name: string, script: string): string {
  writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, name), 0o755);
  return join(dir, name);
}

const alive = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

test("round 5, finding 2: the box lock outlives a crashed operation until the command it ran ends, and a forward it started never holds it", async () => {
  const home = temp.make("fleet-lock-");
  const dir = temp.make("fleet-children-");
  const announce = (file: string, what: string) => `echo ${what} > ${dir}/${file}.tmp && /bin/mv ${dir}/${file}.tmp ${dir}/${file}`;
  const forward = stub(dir, "forward", `tail -f /dev/null < /dev/null > /dev/null 2>&1 &\n${announce("forward.pid", "$!")}`);
  const act = stub(dir, "act", `${announce("act.pid", "$$")}\nexec tail -f /dev/null`);
  const code = `const { withBoxLock } = await import(${JSON.stringify(helper)});
const { capture } = await import(${JSON.stringify(coderHelper)});
await withBoxLock(${JSON.stringify(home)}, "box-a", { waitMs: 0 }, async () => {
  await capture([${JSON.stringify(forward)}], { timeoutMs: 600_000 });
  await capture([${JSON.stringify(act)}], { timeoutMs: 600_000 });
});`;
  const holder = Bun.spawn([process.execPath, "-e", code], { stdout: "inherit", stderr: "inherit" });
  const pids: number[] = [];
  try {
    await appeared(join(dir, "act.pid"));
    pids.push(Number(readFileSync(join(dir, "forward.pid"), "utf8")), Number(readFileSync(join(dir, "act.pid"), "utf8")));
    const holderOfAct = readFileSync(`/proc/${pids[1]}/stat`, "utf8").split(") ")[1]!.split(" ")[1];
    expect(readFileSync(`/proc/${holderOfAct}/cmdline`, "utf8").split("\0").slice(0, 4)).toEqual(["timeout", "-s", "KILL", String(600 + orphanGraceSeconds)]);
    holder.kill("SIGKILL");
    expect(await holder.exited).not.toBe(0);
    await expect(lockBox(home, "box-a", { waitMs: 0 })).rejects.toBeInstanceOf(LockBusy);
    process.kill(pids[1]!, "SIGKILL");
    const unlock = await lockBox(home, "box-a", { waitMs: 60_000 });
    expect(alive(pids[0]!)).toBe(true);
    unlock();
  } finally {
    holder.kill("SIGKILL");
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});

test("under a box lock a command gets the same input, output and exit code, and no descriptor of the lock", async () => {
  const home = temp.make("fleet-lock-");
  const dir = temp.make("fleet-children-");
  const probe = stub(dir, "probe", "read line; echo \"got $line\"; if [ -e /dev/fd/3 ]; then echo has-lock >&2; else echo no-lock >&2; fi; exit 3");
  const result = await withBoxLock(home, "box-a", { waitMs: 0 }, () => capture([probe], { stdin: "hello\n", timeoutMs: 600_000 }));
  expect(result).toEqual({ code: 3, stdout: "got hello\n", stderr: "no-lock\n" });
});

test("two operations in one process exclude each other too, and a step that throws lets go of the lock", async () => {
  const home = temp.make("fleet-lock-");
  const order: string[] = [];
  await withBoxLock(home, "box-a", { waitMs: 0 }, async () => {
    order.push("first");
    await expect(withBoxLock(home, "box-a", { waitMs: 0 }, async () => void order.push("nested"))).rejects.toBeInstanceOf(LockBusy);
  });
  await expect(withBoxLock(home, "box-a", { waitMs: 0 }, async () => { throw new Error("step failed"); })).rejects.toThrow("step failed");
  const unlock = await lockBox(home, "box-a", { waitMs: 0 });
  unlock();
  expect(order).toEqual(["first"]);
});

test("the lock folder is private, and a symlinked folder or lock file is refused before anything is locked", async () => {
  const home = temp.make("fleet-lock-");
  await withBoxLock(home, "box-a", { waitMs: 0 }, async () => undefined);
  expect(statSync(boxLocks(home)).mode & 0o777).toBe(0o700);
  expect(statSync(join(boxLocks(home), "box-a.lock")).mode & 0o777).toBe(0o600);

  const elsewhere = temp.make("fleet-elsewhere-");
  writeFileSync(join(elsewhere, "target"), "keep\n");
  symlinkSync(join(elsewhere, "target"), join(boxLocks(home), "box-b.lock"));
  await expect(withBoxLock(home, "box-b", { waitMs: 0 }, async () => "ran")).rejects.toThrow("symlink");
  expect(readFileSync(join(elsewhere, "target"), "utf8")).toBe("keep\n");

  const linked = temp.make("fleet-lock-");
  mkdirSync(join(linked, ".local/state/fleet"), { recursive: true });
  symlinkSync(elsewhere, boxLocks(linked));
  await expect(withBoxLock(linked, "box-a", { waitMs: 0 }, async () => "ran")).rejects.toThrow("symlink");
  expect(lstatSync(join(elsewhere, "target")).isFile()).toBe(true);

  const loose = temp.make("fleet-lock-");
  mkdirSync(boxLocks(loose), { recursive: true });
  chmodSync(boxLocks(loose), 0o755);
  await withBoxLock(loose, "box-a", { waitMs: 0 }, async () => undefined);
  expect(statSync(boxLocks(loose)).mode & 0o777).toBe(0o700);
});

test("a box lock refuses a name that is not a box", async () => {
  const home = temp.make("fleet-lock-");
  for (const name of ["../box-a", "box-a/../../x", "devbox-1", "box-", "box-a.b", "box--x"]) await expect(withBoxLock(home, name, { waitMs: 0 }, async () => 1)).rejects.toThrow("not a box");
});
