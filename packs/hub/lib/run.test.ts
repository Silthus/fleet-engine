import { expect, test } from "bun:test";
import type { Capture } from "./coder.ts";
import { shellLimitMs } from "./machine.ts";
import { runWith } from "./run.ts";

test("hub commands run through the box capture helper, with its time limit and group kill, and input on stdin", async () => {
  const asked: Array<{ argv: string[]; stdin?: string; timeoutMs: number; runtime?: string }> = [];
  const spawn: Capture = async (argv, options) => (asked.push({ argv, timeoutMs: options.timeoutMs, runtime: options.env?.XDG_RUNTIME_DIR, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) }), { code: 124, stdout: "", stderr: "timed out" });
  const run = runWith(spawn);
  expect(await run(["systemctl", "--user", "daemon-reload"])).toEqual({ code: 124, stdout: "", stderr: "timed out" });
  await run(["sudo", "-n", "tee", "/etc/hosts"], { input: "127.0.0.1 hub\n", timeoutMs: 60_000 });
  expect(asked.map(({ runtime, ...rest }) => (expect(runtime).toBeTruthy(), rest))).toEqual([
    { argv: ["systemctl", "--user", "daemon-reload"], timeoutMs: shellLimitMs },
    { argv: ["sudo", "-n", "tee", "/etc/hosts"], stdin: "127.0.0.1 hub\n", timeoutMs: 60_000 },
  ]);
});
