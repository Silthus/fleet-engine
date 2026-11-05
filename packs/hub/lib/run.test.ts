import { expect, test } from "bun:test";
import { run } from "./run.ts";

test("a command past its time limit is killed with its whole process group, and answers 124", async () => {
  const marker = `fleet-run-test-${process.pid}-${Date.now()}`;
  const started = Date.now();
  const answer = await run(["/bin/sh", "-c", `/bin/sh -c 'tail -f /dev/null; : ${marker}' & wait`], { timeoutMs: 5 });
  expect(answer.code).toBe(124);
  expect(Date.now() - started).toBeLessThan(2000);
  const left = Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim();
  expect(left).toBe("");
});
