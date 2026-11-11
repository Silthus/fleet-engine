import { expect, test } from "bun:test";
import { quotaWatch } from "./quota.ts";

const quota = "API Error: 429 Too Many Requests\n";
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

function watching() {
  const stalls: string[] = [];
  const watch = quotaWatch(0, (line) => stalls.push(line));
  return { watch, stalls, stdout: watch.stream(), stderr: watch.stream() };
}

test("a stream that closes on an unfinished line does not count it as new progress after quota lines", async () => {
  const { watch, stalls, stdout, stderr } = watching();
  stdout.observe("reviewing file ");
  stderr.observe(quota + quota);
  stdout.end();
  await nextTick();
  expect(stalls).toEqual(["API Error: 429 Too Many Requests"]);
  expect(watch.waiting()).toBe("API Error: 429 Too Many Requests");
});

test("an unfinished line on another stream between two quota lines breaks the streak", async () => {
  const { watch, stalls, stdout, stderr } = watching();
  stderr.observe(quota);
  stdout.observe("reviewing file ");
  stderr.observe(quota);
  await nextTick();
  expect(stalls).toEqual([]);
  stderr.observe(quota);
  await nextTick();
  expect(stalls).toEqual(["API Error: 429 Too Many Requests"]);
  watch.stop();
});
