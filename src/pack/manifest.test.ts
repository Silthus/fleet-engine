import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { loadPacks, PackError } from "./manifest.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function sourceWith(packs: Record<string, unknown>) {
  const dir = temp.make();
  for (const [name, manifest] of Object.entries(packs)) {
    mkdirSync(join(dir, "packs", name), { recursive: true });
    writeFileSync(join(dir, "packs", name, "pack.json"), JSON.stringify(manifest));
  }
  return dir;
}

const base = {
  schema: 1,
  name: "base",
  summary: "Safety rules every agent follows.",
  settings: [{ key: "base.heavySlots", question: "How many heavy commands may run at once?", type: "number", default: 2 }],
  workflows: [{ id: "heavy", name: "Heavy slot", sentence: "Builds run in a capped slot.", default: true, needs: ["devbox"] }],
  jobs: [{ id: "prune", command: ["fleet", "prune"], schedule: { every: "1d" }, workflow: "heavy" }],
};

describe("loadPacks", () => {
  test("loads every pack of a source", async () => {
    const packs = await loadPacks(sourceWith({ base }));
    expect(packs.map((pack) => pack.manifest.name)).toEqual(["base"]);
    expect(packs[0]?.manifest.workflows?.[0]?.needs).toEqual(["devbox"]);
  });

  test("rejects a schema it does not know", async () => {
    const dir = sourceWith({ base: { ...base, schema: 2 } });
    expect(loadPacks(dir)).rejects.toThrow(new PackError(`${join(dir, "packs/base/pack.json")}: unknown schema 2`));
  });

  test("rejects a manifest whose name is not its directory", async () => {
    expect(loadPacks(sourceWith({ other: base }))).rejects.toThrow("name base does not match its directory other");
  });

  test("rejects a setting outside the pack's namespace", async () => {
    const settings = [{ ...base.settings[0], key: "hub.heavySlots" }];
    expect(loadPacks(sourceWith({ base: { ...base, settings } }))).rejects.toThrow("setting hub.heavySlots must start with base.");
  });

  test("rejects a workflow need outside the closed set", async () => {
    const workflows = [{ ...base.workflows[0], needs: ["laptop"] }];
    expect(loadPacks(sourceWith({ base: { ...base, workflows } }))).rejects.toThrow("workflow heavy has unknown need laptop");
  });

  test("rejects an item tied to a workflow the pack does not declare", async () => {
    const jobs = [{ ...base.jobs[0], workflow: "missing" }];
    expect(loadPacks(sourceWith({ base: { ...base, jobs } }))).rejects.toThrow("jobs prune names unknown workflow missing");
  });

  test("rejects a T3 job without a task", async () => {
    const jobs = [{ ...base.jobs[0], runner: "t3" }];
    expect(loadPacks(sourceWith({ base: { ...base, jobs } }))).rejects.toThrow("job prune runs on t3 but has no task");
  });
});
