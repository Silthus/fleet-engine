import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, tempDirs } from "../testing/git.ts";
import type { PackJob, PackManifest, Plan } from "../pack/types.ts";
import { doneScreen, firstPrompt, here, repoName, runsByItself, standaloneProblems } from "./done.ts";
import { fakeMachine, fleetSetup, onBox } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const summary = { role: "mac" as const, packs: ["Pull requests", "Memory"], devboxes: [], profileRepo: "nora/fleet-profile", runsByItself: ["Nightly updates, every day at 03:17", "Shared memory, every 5 minutes"] };

describe("the done screen", () => {
  test("sums up this Mac, the profile, and what runs by itself, then gives a first prompt", () => {
    expect(doneScreen(summary)).toEqual([
      "",
      "✓ Fleet is set up.",
      "",
      "  This Mac        Pull requests, Memory. fleet doctor passes.",
      "  Devbox          none. Add one with fleet devbox add <ssh host>.",
      "  Profile         nora/fleet-profile, private. Change it with fleet packs and fleet set.",
      "  Runs by itself  Nightly updates, every day at 03:17",
      "                  Shared memory, every 5 minutes",
      "  Report          fleet triage sends a report of this setup to the Fleet maintainer.",
      "",
      "Paste this into a new thread in T3 Code to start:",
      "",
      `  ${firstPrompt}`,
    ]);
  });

  test("shows each devbox", () => {
    expect(doneScreen({ ...summary, devboxes: ["box-1"], runsByItself: [] })).toContain("  Devbox          box-1: the same profile, signed in, linked with T3 Code here, and it makes signed commits.");
    expect(doneScreen({ ...summary, runsByItself: [] })).toContain("  Runs by itself  nothing yet");
  });

  test("lists jobs that run only on a devbox with its name, and hourly jobs at their minute", () => {
    const jobs = (...list: Array<Pick<PackJob, "id" | "schedule">>) => ({ jobs: list }) as unknown as Plan;
    const nightly = { id: "nightly-update", schedule: { every: "1d" as const, at: "03:17" } };
    const lines = runsByItself(jobs(nightly, { id: "sweep", schedule: { every: "1h", at: "03:17" } }), [], [{ host: "box-1", plan: jobs(nightly, { id: "quality-loop", schedule: { every: "1d" } }) }]);
    expect(lines).toEqual(["nightly-update, every day at 03:17", "sweep, every hour at :17", "quality-loop, every day at 03:17, on box-1"]);
  });

  test("lists a service as running all the time", () => {
    const plan = { jobs: [{ id: "slack-trigger", schedule: { every: "always" }, workflow: "slack-thread" }] } as unknown as Plan;
    expect(runsByItself(plan, [{ workflows: [{ id: "slack-thread", name: "Start a thread from Slack" }] } as unknown as PackManifest])).toEqual(["Start a thread from Slack, all the time"]);
  });

  test("names the profile repo from its clone URL", () => {
    expect(repoName("https://github.com/nora/fleet-profile.git")).toBe("nora/fleet-profile");
    expect(repoName("git@github.com:nora/fleet-profile.git")).toBe("nora/fleet-profile");
  });
});

describe("the final check", () => {
  test("the standalone check finds a proxy for Claude or Codex, and files left from a hub", () => {
    const home = temp.make("home-");
    expect(standaloneProblems(here(home, {}))).toEqual([]);
    expect(standaloneProblems(here(home, { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", OPENAI_BASE_URL: "http://127.0.0.1:8317/v1" }))).toEqual([
      "Claude Code sends its requests to http://127.0.0.1:8317 (ANTHROPIC_BASE_URL in the environment).",
      "Codex sends its requests to http://127.0.0.1:8317/v1 (OPENAI_BASE_URL in the environment).",
    ]);
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } }));
    writeFileSync(join(home, ".codex/config.toml"), 'model_provider = "hub"\n[model_providers.hub]\nbase_url = "http://127.0.0.1:8317/v1"\n');
    writeFileSync(join(home, ".config/fleet/peers.json"), "[]");
    expect(standaloneProblems(here(home, {}))).toEqual([
      "Claude Code sends its requests to http://127.0.0.1:8317 (env.ANTHROPIC_BASE_URL in ~/.claude/settings.json).",
      "Codex sends its requests to http://127.0.0.1:8317/v1 (model_provider hub in ~/.codex/config.toml).",
      "~/.config/fleet/peers.json is left from a Fleet hub. Remove it if this machine no longer uses one.",
    ]);
  });

  test("runs fleet doctor here and on the devbox, and a signed commit there, before the done screen", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home);
    const result = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "node-1"], [], box);
    expect(result.code).toBe(0);
    expect(result.doctored).toHaveLength(1);
    const ran = box.runs.map((run) => onBox(run.command));
    expect(ran).toContainEqual(expect.stringContaining('fleet/engine/fleet" doctor'));
    expect(ran).toContainEqual(expect.stringContaining("git commit -q -S --allow-empty"));
    expect(result.output).toContain("✓ Fleet is set up.");
  });

  test("the standalone check reads each devbox too, and names it", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, {}, { boxFiles: { ".config/fleet/peers.json": "[]", ".claude/settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://10.0.0.9:8317" } }) } });
    const result = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "node-1"], [], box);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  ! Claude Code on node-1 sends its requests to http://10.0.0.9:8317 (env.ANTHROPIC_BASE_URL in ~/.claude/settings.json).");
    expect(result.output).toContain("  ! ~/.config/fleet/peers.json on node-1 is left from a Fleet hub. Remove it if this machine no longer uses one.");
  });

  test("a devbox added after setup is done makes the next setup check again", async () => {
    const home = temp.make("home-");
    const args = ["--non-interactive", "--preset", "starter", "--plan", "claude"];
    expect((await fleetSetup(home, args, [], fakeMachine(home))).code).toBe(0);
    const path = join(home, ".config/fleet/machine.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), devboxes: ["node-2"] }));
    const box = fakeMachine(home);
    const again = await fleetSetup(home, args, [], box);
    expect(again.code).toBe(0);
    expect(again.output).toContain("  $ ssh node-2 fleet doctor");
    expect(again.output).toContain("  ✓ node-2 makes signed commits");
  });

  test("a failing doctor stops setup before the done screen, and a rerun checks again", async () => {
    const home = temp.make("home-");
    const args = ["--non-interactive", "--preset", "starter", "--plan", "claude"];
    const failed = await fleetSetup(home, args, [], fakeMachine(home), undefined, 1);
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("fleet: fleet doctor found something to fix on this machine. Fix what it says above, then run fleet setup again.");
    expect(failed.output).not.toContain("Fleet is set up");

    const passed = await fleetSetup(home, args, [], fakeMachine(home));
    expect(passed.code).toBe(0);
    expect(passed.output).toContain("Welcome back. 8 of 9 done, picking up at Check everything.");
  });
});
