import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { fleetSetup, machineFile, pushedAnswers, savedAnswers } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const machine = machineFile;

describe("fleet setup questions", () => {
  test("asks packs and plans with defaults, shows progress, and moves the answers into the profile", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, [], ["", "", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Fleet setup · 1 of 10 · about 15 min left");
    expect(result.output).toContain("Fleet setup · 4 of 10 · about 9 min left");
    expect(result.output).toContain("  1) Everyday  Pull-requests, Orchestration, Communication (default)");
    expect(result.output).toContain("  ✓ Claude and ChatGPT");
    expect(machine(home)).toEqual({
      schema: 1,
      role: "linux",
      name: hostname(),
      profileDir: profilePath(home),
      devboxes: [],
      setup: { done: ["bootstrap", "github", "packs", "plans", "profile", "apply", "devbox", "claude", "chatgpt", "check"] },
    });
    expect(savedAnswers(home)).toMatchObject({ packs: ["pull-requests", "orchestration", "communication"], workflows: {}, plan: "both" });
    expect(result.applied).toEqual([profilePath(home)]);
  });

  test("on a Mac, saves the mac role, offers a devbox, and sets up this Mac", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, [], ["", "", ""], undefined, undefined, 0, "darwin");
    expect(result.code).toBe(0);
    expect(result.output).toContain("▶ Set up this Mac: fleet apply installs your packs");
    expect(result.output).not.toContain("Set up this machine");
    expect(result.output).toContain("  This Mac ");
    expect(machine(home)).toMatchObject({ schema: 1, role: "mac", devboxes: [], setup: { done: ["bootstrap", "github", "packs", "plans", "profile", "apply", "devbox", "claude", "chatgpt", "check"] } });
    expect(result.applied).toEqual([profilePath(home)]);
  });

  test("keeps the name and role that apply saves, though setup writes its progress after apply", async () => {
    const home = temp.make("home-");
    const path = join(home, ".config/fleet/machine.json");
    const placeAsHub = () => writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), name: "hub-1", role: "hub" }));
    const result = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "codex"], [], undefined, undefined, 0, "linux", placeAsHub);
    expect(result.code).toBe(0);
    expect(machine(home)).toMatchObject({ name: "hub-1", role: "hub" });
  });

  test("Ctrl-C keeps every answer, and a rerun picks up at the next question", async () => {
    const home = temp.make("home-");
    const stopped = await fleetSetup(home, [], ["2"]);
    expect(stopped.code).toBe(130);
    expect(stopped.output).toEndWith("Stopped. Run fleet setup again to pick up at Your AI plans.");
    expect(machine(home).setup).toEqual({ done: ["bootstrap", "github", "packs"], draft: { packs: ["pull-requests"], workflows: {} } });

    const resumed = await fleetSetup(home, [], ["3", ""]);
    expect(resumed.code).toBe(0);
    expect(resumed.output).toContain("Welcome back. 3 of 10 done, picking up at Your AI plans.");
    expect(resumed.prompts).toHaveLength(2);
    expect(machine(home).setup).toEqual({ done: ["bootstrap", "github", "packs", "plans", "profile", "apply", "devbox", "chatgpt", "check"] });
    expect(savedAnswers(home)).toMatchObject({ packs: ["pull-requests"], workflows: {}, plan: "codex" });
  });

  test("keeps picks carried from the page with one key, or changes them with e", async () => {
    const args = ["--preset", "michael", "--remove", "memory", "--workflows", "pr-digest=off", "--set", "pull-requests.freeReviews=3", "--plan", "claude"];
    const home = temp.make("home-");
    const kept = await fleetSetup(home, args, ["", ""]);
    expect(kept.code).toBe(0);
    expect(kept.output).toContain("  From your command: Pull-requests, Orchestration, Communication");
    expect(kept.output).toContain("  Workflows: pr-digest off");
    expect(kept.prompts).toEqual(["Press ↵ to keep them, or e to change them: ", "  Go ahead? (Y/n) "]);
    expect(savedAnswers(home)).toMatchObject({
      settings: { "pull-requests.freeReviews": 3 },
      packs: ["pull-requests", "orchestration", "communication"],
      workflows: { "quality-loop": true, "signal-loop": true },
      plan: "claude",
    });

    const other = temp.make("home-");
    const changed = await fleetSetup(other, args, ["e", "2", ""]);
    expect(changed.code).toBe(0);
    expect(savedAnswers(other)).toMatchObject({ packs: ["pull-requests"], workflows: {} });
  });

  test("picks packs one by one", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, [], ["4", "y", "n", "", "y", "n", "n", "n", "n", "n", "", ""]);
    expect(result.code).toBe(0);
    expect(savedAnswers(home).packs).toEqual(["pull-requests", "communication", "memory"]);
    expect(result.output).toContain("One always-on devbox manages the others");

    const needs = temp.make("home-");
    const picked = await fleetSetup(needs, [], ["4", "n", "y", "n", "n", "n", "n", "n", "n", "n", "", ""]);
    expect(picked.output).toContain("  Orchestration needs Pull-requests, so it is on too.");
    expect(savedAnswers(needs).packs).toEqual(["orchestration", "pull-requests"]);
  });

  test("--non-interactive never asks, and fails with a list of the answers it still needs", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "devbox" }));
    const missing = await fleetSetup(home, ["--non-interactive", "--preset", "michael"]);
    expect(missing.code).toBe(2);
    expect(missing.prompts).toEqual([]);
    expect(missing.output).toContain("fleet setup --non-interactive needs these answers and sign-ins. Add the answers to the command and run it again:");
    expect(missing.output).toContain("  --set orchestration.loopProject=<value>");
    expect(missing.output).toContain("  --set orchestration.qualityArea=<value>");
    expect(missing.output).toContain("  --set orchestration.ledgerRepo=<value>");
    expect(missing.output).not.toContain("memory.repo");
    expect(machine(home).setup.done).toEqual(["bootstrap", "github", "packs", "plans", "setting:orchestration.criticalPaths"]);
    expect(machine(home).profileDir).toBeUndefined();

    const sets = ["--set", "orchestration.loopProject=~/code/app", "--set", "orchestration.qualityArea=src/api", "--set", "orchestration.ledgerRepo=me/ledger"];
    const answered = await fleetSetup(home, ["--non-interactive", "--preset", "michael", ...sets]);
    expect(answered.code).toBe(0);
    expect(answered.prompts).toEqual([]);
    expect(answered.output).toContain("Set up this machine");
    expect(savedAnswers(home).settings).toEqual({ "orchestration.loopProject": "~/code/app", "orchestration.qualityArea": "src/api", "orchestration.ledgerRepo": "me/ledger", "memory.repo": "nora/fleet-memory" });
  });

  test("a rerun keeps answers saved before Ctrl-C marked their step done", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    const draft = { packs: ["pull-requests", "orchestration"], workflows: {}, plan: "claude", settings: { "orchestration.loopProject": "~/code/app", "orchestration.qualityArea": "src", "orchestration.ledgerRepo": "me/ledger" } };
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "linux", setup: { done: ["bootstrap"], draft } }));
    const resumed = await fleetSetup(home, ["--non-interactive"]);
    expect(resumed.code).toBe(0);
    expect(savedAnswers(home)).toMatchObject(draft);

    const asked = temp.make("home-");
    mkdirSync(join(asked, ".config/fleet"), { recursive: true });
    writeFileSync(join(asked, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "linux", setup: { done: ["bootstrap"], draft: { packs: ["pull-requests"], workflows: {} } } }));
    const kept = await fleetSetup(asked, [], ["", "", ""]);
    expect(kept.output).toContain("  From your last answer: Pull-requests");
    expect(savedAnswers(asked).packs).toEqual(["pull-requests"]);
  });

  test("picks from the command change answers a finished setup already has", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--non-interactive", "--preset", "starter"])).code).toBe(0);
    const changed = await fleetSetup(home, ["--non-interactive", "--preset", "everyday", "--plan", "claude"]);
    expect(changed.code).toBe(0);
    expect(pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "orchestration", "communication"], plan: "claude" });
    expect(changed.output).toContain("Set up this machine");

    const same = await fleetSetup(home, ["--non-interactive", "--preset", "everyday", "--plan", "claude"]);
    expect(same.code).toBe(0);
    expect(same.output).not.toContain("Fleet setup ·");
  });

  test("refuses a pick that leaves a pack without a pack it needs", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, ["--non-interactive", "--remove", "pull-requests"]);
    expect(result.code).toBe(2);
    expect(result.output).toStartWith("fleet setup: Orchestration needs Pull-requests. Add pull-requests, or remove orchestration.");
  });

  test("refuses unknown packs, workflows, and settings before it asks anything; an unknown workflow waits for GitHub sign-in, which may find a team pack", async () => {
    const home = temp.make("home-");
    for (const [args, message] of [
      [["--add", "nope"], "fleet setup: no pack named nope."],
      [["--workflows", "nope=on"], "fleet setup: --workflows: no workflow named nope"],
      [["--workflows", "toString=on"], "fleet setup: --workflows: no workflow named toString"],
      [["--set", "pull-requests.freeReviews=many"], "fleet setup: pull-requests.freeReviews takes a number"],
      [["--set", "nope.key=1"], "fleet setup: --set nope.key: no pack has this setting"],
      [["--preset", "nope"], "fleet setup: --preset nope: choose starter, everyday, michael"],
    ] as const) {
      const result = await fleetSetup(home, [...args]);
      expect(result.code).toBe(2);
      expect(result.output.split("\n").find((line) => line.startsWith("fleet setup:"))).toStartWith(message);
      expect(result.prompts).toEqual([]);
    }
  });

  test("--set on a finished setup changes the profile and pushes it", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const again = await fleetSetup(home, ["--set", "pull-requests.freeReviews=5"]);
    expect(again.code).toBe(0);
    expect(pushedAnswers(home).settings).toEqual({ "pull-requests.freeReviews": 5 });
  });
});
