import { afterEach, expect, test } from "bun:test";
import { onHub } from "../hub/ssh.ts";
import { tempDirs } from "./git.ts";
import { fakeSsh } from "./ssh.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const ssh = onHub("hub-1", ["hello"]);

test("a stopped call ends as a killed ssh and never reaches the host", async () => {
  const reached: string[][] = [];
  const run = fakeSsh(temp.make("ssh-home-"), { "hub-1": async (args) => (reached.push(args), { code: 0, stdout: "hi\n", stderr: "" }) });
  const stopped = new AbortController();
  stopped.abort();
  expect(await run(ssh, { signal: stopped.signal })).toEqual({ code: 143, stdout: "", stderr: "" });
  expect(await run(ssh)).toEqual({ code: 0, stdout: "hi\n", stderr: "" });
  expect(reached).toEqual([["hello"]]);
});
