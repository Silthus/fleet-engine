import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { runSteps, type Step } from "./runner.ts";
import { scripted, fakeMachine, fleetSetup } from "./testing.ts";
import { installLogPath, timingsPath, type Timings } from "./timings.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const timings = (home: string) => JSON.parse(readFileSync(timingsPath(home), "utf8")) as Timings;
const start = Date.parse("2026-11-11T10:00:00Z");

describe("setup timings", () => {
  test("records each step, which ones needed the person, and prints the time to a usable machine", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, { github: 3 }, { startedAt: start });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""], box);
    expect(result.code).toBe(0);
    const saved = timings(home);
    expect(saved.started).toBe("2026-11-11T10:00:00.000Z");
    expect(saved.usable).toBe("2026-11-11T10:00:06.000Z");
    expect(saved.usableSeconds).toBe(6);
    expect(saved.steps.map((step) => [step.id, step.blocked])).toEqual([
      ["bootstrap", false],
      ["github", true],
      ["packs", true],
      ["plans", false],
      ["profile", true],
      ["apply", false],
      ["devbox", false],
      ["claude", false],
      ["check", false],
    ]);
    expect(saved.steps[1]).toMatchObject({ title: "Sign in to GitHub", kind: "human", outcome: "done", start: "2026-11-11T10:00:00.000Z", end: "2026-11-11T10:00:06.000Z", seconds: 6 });
    expect(saved.blockedSteps).toBe(3);
    expect(result.output).toContain("  Usable 6 s after the start. 3 steps needed you.");
  });

  test("starts the clock when get.sh started, and lists its phases first", async () => {
    const home = temp.make("home-");
    const epoch = start / 1000;
    mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
    writeFileSync(installLogPath(home), `start ${epoch - 200}\ntools ${epoch - 80} needed-you\nt3 ${epoch - 30}\nengine ${epoch - 10}\npackages ${epoch - 5}\n`);
    const box = fakeMachine(home, {}, { startedAt: start });
    const result = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], box);
    expect(result.code).toBe(0);
    const saved = timings(home);
    expect(saved.started).toBe("2026-11-11T09:56:40.000Z");
    expect(saved.steps.slice(0, 4).map((step) => [step.id, step.seconds, step.blocked])).toEqual([
      ["install:tools", 120, true],
      ["install:t3", 50, false],
      ["install:engine", 20, false],
      ["install:packages", 5, false],
    ]);
    expect(saved.usableSeconds).toBe(200);
    expect(result.output).toContain("  Usable 3 min 20 s after the start. 1 step needed you.");
  });

  test("ignores an install log from an earlier install", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
    writeFileSync(installLogPath(home), `start ${start / 1000 - 3 * 3600}\ntools ${start / 1000 - 3 * 3600 + 10}\n`);
    const result = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], fakeMachine(home, {}, { startedAt: start }));
    expect(result.code).toBe(0);
    expect(timings(home).started).toBe("2026-11-11T10:00:00.000Z");
    expect(timings(home).steps.some((step) => step.id.startsWith("install:"))).toBe(false);
  });

  test("a run without a person counts each open step as needing the person, and the next run keeps the same start", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, { claude: 5 }, { startedAt: start });
    const first = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], box);
    expect(first.code).toBe(2);
    expect(timings(home).usable).toBeNull();
    expect(timings(home).steps.find((step) => step.id === "claude")).toMatchObject({ blocked: true, outcome: "unanswered" });

    const second = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], fakeMachine(home, {}, { startedAt: start + 90_000 }));
    expect(second.code).toBe(0);
    const saved = timings(home);
    expect(saved.started).toBe("2026-11-11T10:00:00.000Z");
    expect(saved.usableSeconds).toBe(90);
    expect(saved.blockedSteps).toBe(1);
    expect(second.output).toContain("  Usable 1 min 30 s after the start. 1 step needed you.");
  });

  test("records a step that failed, with its error, and leaves the machine not usable", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], fakeMachine(home, {}, { startedAt: start }), undefined, 1);
    expect(result.code).toBe(1);
    const saved = timings(home);
    expect(saved.usable).toBeNull();
    expect(saved.steps.at(-1)).toMatchObject({ id: "check", outcome: "failed", error: expect.stringContaining("fleet doctor found something to fix") });
  });

  test("a finished setup run again starts a new record and prints nothing when no step ran", async () => {
    const home = temp.make("home-");
    const args = ["--non-interactive", "--preset", "starter", "--plan", "claude"];
    expect((await fleetSetup(home, args, [], fakeMachine(home, {}, { startedAt: start }))).code).toBe(0);
    const again = await fleetSetup(home, args, [], fakeMachine(home, {}, { startedAt: start + 3_600_000 }));
    expect(again.code).toBe(0);
    expect(again.output).not.toContain("Usable");
    expect(timings(home).started).toBe("2026-11-11T10:00:00.000Z");
  });
});

describe("live progress", () => {
  test("a long step that runs by itself says every 15 s that it still runs, and how long", async () => {
    const io = scripted([]);
    let now = 0;
    const ticks: Array<() => void> = [];
    let release = () => {};
    const slow: Step = {
      id: "apply",
      title: "Set up this Mac",
      minutes: 3,
      kind: "auto",
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
          for (const seconds of [15, 30, 75]) (now = seconds * 1000), ticks[0]!();
          release();
        }),
    };
    const result = await runSteps(() => [slow], {
      terminal: io.terminal,
      done: [],
      save: async () => {},
      clock: { now: () => now },
      every: (ms, tick) => (expect(ms).toBe(15_000), ticks.push(tick), () => ticks.splice(0)),
    });
    expect(result.finished).toBe(true);
    expect(io.output()).toContain("  … Set up this Mac: still running, 15 s so far");
    expect(io.output()).toContain("  … Set up this Mac: still running, 1 min 15 s so far");
    expect(ticks).toEqual([]);
  });
});
