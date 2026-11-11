import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { fakeMachine, fleetSetup, githubRepo, pushedAnswers } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

async function nameHub(profile: string) {
  const answers = JSON.parse(readFileSync(join(profile, "fleet.json"), "utf8"));
  if (answers.hub) return;
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ ...answers, hub: "coder.fleet-hub" }, null, 2) + "\n");
  await spawnGit(profile, "commit", "-q", "-am", "Name the hub");
  await spawnGit(profile, "push", "-q");
}

describe("fleet setup with a devbox", () => {
  test("asks the settings only a devbox needs once a devbox is added, saves them to the profile before the box applies it, and a run without a person lists them", async () => {
    const question = "? Which T3 project do the loops and the PR digest run in?";
    const args = ["--preset", "everyday", "--plan", "claude", "--workflows", "pr-digest=on"];
    const alone = temp.make("home-");
    expect((await fleetSetup(alone, [...args, "--devbox", "skip"], ["", ""], fakeMachine(alone))).output).not.toContain(question);

    const home = temp.make("home-");
    const result = await fleetSetup(home, [...args, "--devbox", "node-1"], ["", "", "~/code/app"], fakeMachine(home));
    expect(result.code).toBe(0);
    const output = result.output;
    expect(output.indexOf(question)).toBeGreaterThan(output.indexOf("  ✓ node-1"));
    expect(output.indexOf(question)).toBeLessThan(output.indexOf("▶ Install Fleet on node-1"));
    expect((await pushedAnswers(home)).settings["orchestration.loopProject"]).toBe("~/code/app");

    const later = temp.make("home-");
    const waiting = await fleetSetup(later, ["--non-interactive", ...args, "--devbox", "node-9"], [], fakeMachine(later));
    expect(waiting.code).toBe(2);
    expect(waiting.output).toContain("  --set orchestration.loopProject=<value>   Which T3 project do the loops and the PR digest run in?");
  });

  test("a devbox setting whose push failed is pushed on the next run before the box is installed", async () => {
    const args = ["--preset", "everyday", "--plan", "claude", "--workflows", "pr-digest=on", "--devbox", "node-1"];
    const home = temp.make("home-");
    expect((await fleetSetup(home, args, ["", ""], fakeMachine(home))).code).toBe(130);
    const rejecting = join(githubRepo(home, "nora/fleet-profile"), "hooks/pre-receive");
    writeFileSync(rejecting, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect((await fleetSetup(home, args, ["~/code/app"], fakeMachine(home))).output).toContain("could not push answers");

    const blocked = await fleetSetup(home, ["--non-interactive", ...args], [], fakeMachine(home));
    expect(blocked.output).toContain("could not push answers: ! [remote rejected] main -> main (pre-receive hook declined). Fix that, then try again.");
    expect(blocked.output).not.toContain("▶ Install Fleet on node-1");

    rmSync(rejecting);
    expect((await fleetSetup(home, ["--non-interactive", ...args], [], fakeMachine(home))).code).toBe(0);
    expect((await pushedAnswers(home)).settings["orchestration.loopProject"]).toBe("~/code/app");
  });

  test("fleet setup --devbox lists the node in the profile, and the hub takes it before the node asks it for a credential and links it in T3 Code once the node runs T3", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home);
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "coder.fleet-node-1"], ["", "", ""], box, undefined, 0, "linux", nameHub);
    expect(result.code).toBe(0);
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.fleet-node-1"]);
    expect(box.hubUpdates).toEqual(["coder.fleet-hub"]);
    expect(box.credentials).toEqual([{ node: "coder.fleet-node-1", issued: true }]);
    expect(result.output).toContain("✓ The hub, coder.fleet-hub, took coder.fleet-node-1: its disk watch, tunnels and credentials include it now.");
    expect(box.hubLinked).toEqual(["coder.fleet-node-1"]);
    expect(result.output).toContain("✓ The hub, coder.fleet-hub, linked coder.fleet-node-1 in T3 Code.");
  });

  test("fleet setup run again has the hub take the node, then applies the node's profile and links it from the hub, when the hub could not take it on an earlier run that stopped or finished", async () => {
    for (const [polls, firstCode] of [[{ "box:github": 1 }, 2], [{}, 0]] as const) {
      const home = temp.make("home-");
      const args = ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "coder.fleet-node-1"];
      for (const hubUpdateFails of ["fleet update: the engine has local changes.", undefined]) {
        const failing = fakeMachine(home, polls, hubUpdateFails ? { hubUpdateFails } : { hubDown: true });
        expect((await fleetSetup(home, args, [], failing, undefined, 0, "linux", nameHub)).code).toBe(firstCode);
      }
      const box = fakeMachine(home);
      expect((await fleetSetup(home, args, [], box, undefined, 0, "linux", nameHub)).code).toBe(0);
      expect(box.hubUpdates).toEqual(["coder.fleet-hub"]);
      expect(box.credentials).toEqual([{ node: "coder.fleet-node-1", issued: true }]);
      expect(box.hubLinked).toEqual(["coder.fleet-node-1"]);
    }
  });
});
