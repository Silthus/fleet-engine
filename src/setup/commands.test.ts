import { expect, test } from "bun:test";
import { realMachine } from "./commands.ts";

test.if(process.platform === "linux")("a command that runs past its time limit returns, since everything it started ends, even a process that holds its output open", async () => {
  const result = await realMachine.exec(["sh", "-c", "tail -f /dev/null & echo $!; wait"], { timeoutMs: 100 });
  const holder = Number(result.output.trim().split("\n")[0]);
  try {
    expect(result.code).not.toBe(0);
    expect(holder).toBeGreaterThan(1);
  } finally {
    try {
      process.kill(holder, "SIGKILL");
    } catch {}
  }
}, 2000);
