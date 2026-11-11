import { expect, test } from "bun:test";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { changeLedger, readLedger } from "./ledger.ts";

const temp = tempDirs();
const step = (id: string) => ({ pack: "team", id, check: ["box-is-on"], undo: ["box-off"] });

test("keeps every step that two Fleet processes record at once", async () => {
  const home = temp.make("home-");
  const writer = (name: string) =>
    Bun.spawn(["bun", "-e", `const { changeLedger } = await import(${JSON.stringify(join(import.meta.dir, "ledger.ts"))}); await Promise.all(Array.from({ length: 20 }, (_, index) => changeLedger(${JSON.stringify(home)}, "team/${name}-" + index, { pack: "team", id: "${name}-" + index, check: ["box-is-on"], undo: ["box-off"] })));`], { stderr: "inherit" }).exited;
  expect(await Promise.all([writer("a"), writer("b")])).toEqual([0, 0]);
  expect((await readLedger(home)).length).toBe(40);
});

test("keeps every step that one process records at once", async () => {
  const home = temp.make("home-");
  await Promise.all(["one", "two", "three"].map((id) => changeLedger(home, `team/${id}`, step(id))));
  expect((await readLedger(home)).map((item) => item.id).sort()).toEqual(["one", "three", "two"]);
});
