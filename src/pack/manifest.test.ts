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

  test("rejects a step that waits for a human step the pack does not declare", async () => {
    const human = [{ id: "coder", say: "Sign in to Coder", probe: ["coder", "whoami"] }];
    expect(loadPacks(sourceWith({ base: { ...base, human, steps: [{ id: "start", run: ["start"], after: "coder" }] } }))).resolves.toHaveLength(1);
    expect(loadPacks(sourceWith({ base: { ...base, human, steps: [{ id: "start", run: ["start"], after: "github" }] } }))).rejects.toThrow("steps start: after must name a human step of this pack");
  });

  test("rejects malformed nested items with a clear error", async () => {
    const setting = base.settings[0];
    const row = { role: "review", work: "Review", provider: "codex", model: "m", effort: "high" };
    const task = { prompt: "Run the loop.", projectSetting: "base.project", modelRole: "worker", workspaceStrategy: "worktree", runtimeMode: "auto" };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ settings: [{ ...setting, default: "two" }] }, "settings base.heavySlots: default does not fit type number"],
      [{ settings: [{ ...setting, type: "choice", choices: "a,b" }] }, "choices must list a value and a label each"],
      [{ jobs: [{ ...base.jobs[0], runner: "t3", task: {} }] }, "task needs a prompt, a projectSetting, and a modelRole"],
      [{ jobs: [{ ...base.jobs[0], runner: "t3", task: { ...task, schedule: "daily" } }] }, "drop task.id and task.schedule"],
      [{ steps: [null] }, "steps[0] must be an object"],
      [{ guides: [{ guide: "../../escape", path: "g.md" }] }, "guide must be lowercase words joined by dashes"],
      [{ steps: [{ id: "cli", run: ["true"], plans: ["gemini"] }] }, "steps cli: plans must list claude, codex, or both"],
      [{ files: [{ path: "hook.ts" }] }, "files [0]: needs a path and a target"],
      [{ files: [{ path: "hook.ts", target: ".hook.ts", workflow: "nope" }] }, "files .hook.ts names unknown workflow nope"],
      [{ models: { gemini: [] } }, "models must map claude, codex, or both to rows"],
      [{ models: { claude: [{ role: "review", work: "Review", provider: "claude", model: "m", effort: "huge" }] } }, "each row needs a role, work"],
      [{ models: { claude: [row, row] } }, "models claude: role review is listed twice"],
    ];
    for (const [fields, message] of cases) {
      expect(loadPacks(sourceWith({ base: { ...base, ...fields } }))).rejects.toThrow(message);
    }
    const jobs = [{ ...base.jobs[0], runner: "t3", task }];
    expect((await loadPacks(sourceWith({ base: { ...base, jobs } })))[0]?.manifest.jobs?.[0]?.task?.prompt).toBe("Run the loop.");
  });
});
