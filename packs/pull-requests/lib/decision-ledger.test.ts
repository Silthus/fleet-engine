import { afterEach, expect, test } from "bun:test";
import { checkout, cleanFixtures, reviewHead } from "./proof-testing.ts";

afterEach(cleanFixtures);

const lineOf = (output: string, start: string) => output.split("\n").find((line) => line.startsWith(start));
const idIn = (output: string) => /\[(d-[0-9a-f]+)\]/.exec(output)![1]!;

test("a gap reason recorded again after the user's acceptance leaves the gap accepted (2026-11-12)", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.fleet("require", "--kinds", "prod-shape");
  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No production read access");
  pr.choose("Accept the gap", "Accept the prod-shape gap? example/product#42: No production read access");
  const recorded = await pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "prod-shape", "--pr", "example/product#42");
  expect(recorded.code).toBe(0);
  const id = idIn(recorded.output);

  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "Still no production read access, reworded");
  const gate = await pr.fleet("gate");
  const short = (await pr.git("rev-parse", "HEAD")).slice(0, 7);
  expect(lineOf(gate.output, "prod-shape:")).toBe(`prod-shape: gap from ${short}, accepted by 👤 decision ${id} (2026-10-25 "Accept the gap"): Still no production read access, reworded`);
  expect(gate.code).toBe(0);
});
