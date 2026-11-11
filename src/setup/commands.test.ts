import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { realMachine } from "./commands.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function running(pid: number) {
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}
const holdOutputOpen = (fifo: string) => ["sh", "-c", `tail -f /dev/null & echo $! > ${fifo}; wait`];

async function holderPid(fifo: string) {
  const reader = Bun.spawn(["cat", fifo], { stdout: "pipe" });
  return Number((await new Response(reader.stdout).text()).trim());
}

async function fifoIn(dir: string) {
  const fifo = join(dir, "holder");
  await Bun.spawn(["mkfifo", fifo]).exited;
  return fifo;
}

test.if(process.platform === "linux")("a command that runs past its time limit returns, since everything it started ends, even a process that holds its output open", async () => {
  const fifo = await fifoIn(temp.make("exec-"));
  const [result, holder] = await Promise.all([realMachine.exec(holdOutputOpen(fifo), { timeoutMs: 1000 }), holderPid(fifo)]);
  try {
    expect(result.code).not.toBe(0);
    expect(running(holder)).toBe(false);
  } finally {
    try {
      process.kill(holder, "SIGKILL");
    } catch {}
  }
}, 4000);

test.if(process.platform === "linux")("a command with a time limit ends with everything it started when Fleet is interrupted or terminated", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const fifo = await fifoIn(temp.make("exec-"));
    const script = `import { realMachine } from ${JSON.stringify(join(import.meta.dir, "commands.ts"))}; await realMachine.exec(${JSON.stringify(holdOutputOpen(fifo))}, { timeoutMs: 600000 });`;
    const fleet = Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "ignore" });
    const holder = await holderPid(fifo);
    try {
      fleet.kill(signal);
      await fleet.exited;
      expect({ signal, running: running(holder) }).toEqual({ signal, running: false });
    } finally {
      try {
        process.kill(holder, "SIGKILL");
      } catch {}
    }
  }
}, 4000);
