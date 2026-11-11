import { afterEach, describe, expect, test } from "bun:test";
import { main } from "../cli.ts";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { engineRoot, fakeMachine, fleetSetup, pushedAnswers, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const onMac = (home: string, args: string[], replies: string[] = []) => fleetSetup(home, args, replies, fakeMachine(home), undefined, 0, "darwin");

/** A Mac with a finished starter setup whose profile then gained a pack, the Hub pack with its hub, and a workflow through fleet packs. The Hub pack's certificate step later stops a non-interactive rerun, after the profile is pushed. */
async function grownProfile() {
  const home = temp.make("home-");
  expect((await onMac(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"])).code).toBe(0);
  const io = scripted([]);
  const packs = (args: string[]) => main(["packs", ...args], { home, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: fakeMachine(home).machine } });
  expect(await packs(["--add", "communication", "--add", "hub", "--workflows", "pr-digest=on", "--set", "hub.alias=coder.fleet-hub"])).toBe(0);
  return home;
}

describe("a second fleet setup", () => {
  test("with no flags keeps the profile's packs, Hub pack, and workflows", async () => {
    const home = await grownProfile();
    await onMac(home, ["--non-interactive"]);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "communication", "hub"], workflows: { "pr-digest": true } });
  });

  test("with --add, --remove, or --workflows changes only what they name", async () => {
    const home = await grownProfile();
    const result = await onMac(home, ["--non-interactive", "--add", "memory", "--remove", "communication", "--workflows", "shell-guards=on", "--plan", "both"]);
    expect(result.output).toContain("✓ Pull requests, Hub, Memory");
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "hub", "memory"], workflows: { "pr-digest": true, "shell-guards": true }, plan: "both" });
  });

  test("with --preset picks that preset again, in place of the profile's packs", async () => {
    const home = await grownProfile();
    await onMac(home, ["--non-interactive", "--preset", "starter"]);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests"], workflows: {} });
  });
});
