import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import type { AvailableSource, ProfileFile } from "../pack/types.ts";
import { defaultSources } from "../setup/defaults.ts";
import { git, isolateGit, tempDirs } from "../testing/git.ts";
import { engineSource, resolveEngine } from "../testing/packs.ts";
import { settingsCommand } from "./settings.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const engineRoot = join(import.meta.dir, "../..");

function machineWithProfile(settings: Record<string, unknown> = {}) {
  const home = temp.make("home-");
  const remote = join(home, "remote.git");
  git(home, "init", "-q", "--bare", "-b", "main", remote);
  const dir = join(home, "profile");
  git(home, "clone", "-q", remote, dir);
  const profile = { schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: defaultSources, packs: ["pull-requests"], plan: "both", settings, workflows: {} };
  writeFileSync(join(dir, "fleet.json"), JSON.stringify(profile, null, 2) + "\n");
  git(dir, "add", "fleet.json");
  git(dir, "commit", "-q", "-m", "Start");
  git(dir, "push", "-q", "-u", "origin", "main");
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "linux", profileDir: dir }));
  return { home, pushed: () => JSON.parse(git(home, "--git-dir", remote, "show", "main:fleet.json")) };
}

async function fleet(home: string, args: string[], applyCode = 0) {
  const lines: string[] = [];
  const applied: string[] = [];
  const apply = async (dir: string) => (applied.push(dir), applyCode);
  const code = await main(args, { home, engineRoot, platform: "linux", print: (line) => lines.push(line), apply });
  return { code, output: lines.join("\n"), applied };
}

describe("fleet packs", () => {
  test("lists every pack, marks the ones that are on, and shows their workflows", async () => {
    const { home } = machineWithProfile();
    const result = await fleet(home, ["packs"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  ✓ pull-requests  ");
    expect(result.output).toContain("      Workflows: draft-prs on, pr-care on, ship-words on");
    expect(result.output).toContain("  · memory  ");
    expect(result.output).toEndWith("Change them with fleet packs [--add <pack>]... [--remove <pack>]... [--workflows <id=on|off,...>] [--set <pack.key=value>]....");
  });

  test("turns packs and workflows on and off, pushes the profile, and applies here", async () => {
    const { home, pushed } = machineWithProfile();
    const result = await fleet(home, ["packs", "--add", "communication", "--workflows", "quality-loop=on,pr-care=off"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("✓ Saved your packs in your profile and pushed it.");
    expect(result.output).toEndWith("This machine has it now. Your other machines pick it up at their next fleet update.");
    expect(pushed()).toMatchObject({ packs: ["pull-requests", "communication"], workflows: { "quality-loop": true, "pr-care": false } });
    expect(result.applied).toEqual([join(home, "profile")]);

    const removed = await fleet(home, ["packs", "--remove", "communication", "--workflows", "pr-care=on"]);
    expect(removed.code).toBe(0);
    expect(pushed()).toMatchObject({ packs: ["pull-requests"], workflows: { "quality-loop": true } });
  });

  test("keeps workflow choices of packs whose source is not on this machine, and takes --set like setup", async () => {
    const { home, pushed } = machineWithProfile();
    const dir = join(home, "profile");
    writeFileSync(join(dir, "fleet.json"), JSON.stringify({ ...JSON.parse(git(dir, "show", "HEAD:fleet.json")), workflows: { "team-dangerous": false } }, null, 2) + "\n");
    git(dir, "commit", "-q", "-am", "Turn off a team workflow");
    const result = await fleet(home, ["packs", "--add", "communication", "--set", "pull-requests.freeReviews=3"]);
    expect(result.code).toBe(0);
    expect(pushed()).toMatchObject({ packs: ["pull-requests", "communication"], workflows: { "team-dangerous": false }, settings: { "pull-requests.freeReviews": 3 } });
  });

  test("refuses to leave a pack without a pack it needs", async () => {
    const { home, pushed } = machineWithProfile();
    expect((await fleet(home, ["packs", "--add", "orchestration"])).code).toBe(0);
    const result = await fleet(home, ["packs", "--remove", "pull-requests"]);
    expect(result.code).toBe(2);
    expect(result.output).toStartWith("fleet packs: Orchestration needs Pull-requests. Add pull-requests, or remove orchestration.");
    expect(pushed().packs).toEqual(["pull-requests", "orchestration"]);
  });

  test("a change that does not apply here stays saved, and says how to finish", async () => {
    const { home, pushed } = machineWithProfile();
    const result = await fleet(home, ["packs", "--add", "memory"], 1);
    expect(result.code).toBe(1);
    expect(pushed().packs).toEqual(["pull-requests", "memory"]);
    expect(result.output).toEndWith("The change is saved. Fix what it says above, then run fleet apply.");
  });

  test("refuses unknown packs and workflows without touching the profile", async () => {
    const { home, pushed } = machineWithProfile();
    for (const [args, message] of [
      [["--add", "nope"], "fleet packs: no pack named nope."],
      [["--remove", "base"], "fleet packs: the base pack is always on"],
      [["--workflows", "nope=on"], "fleet packs: --workflows: no workflow named nope"],
      [["--preset", "starter"], "fleet packs: usage: fleet packs"],
    ] as const) {
      const result = await fleet(home, ["packs", ...args]);
      expect(result.code).toBe(2);
      expect(result.output).toStartWith(message);
    }
    expect(pushed().packs).toEqual(["pull-requests"]);
  });
});

describe("fleet settings and fleet set", () => {
  test("lists the settings of the packs that are on, with defaults marked", async () => {
    const { home } = machineWithProfile({ "pull-requests.panelSlots": 4 });
    const result = await fleet(home, ["settings"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  pull-requests.freeReviews = 2 (default)");
    expect(result.output).toContain("  pull-requests.panelSlots = 4");
    expect(result.output).toContain("  pull-requests.mergeCommand = not set");
    expect(result.output).not.toContain("memory.repo");
    expect(result.output).toEndWith("Change one with fleet set <pack.key>=<value>.");
  });

  test("lists an engine setting once when a pack overrides its default, with the value that wins", async () => {
    const engine = await engineSource();
    const signer = { key: "identity.signer", question: "Which key signs?", type: "choice" as const, choices: [{ value: "1password", label: "1Password" }], default: "1password", ask: "never" as const };
    const team: AvailableSource = { ref: { name: "team", repo: "team/packs", ref: "main" }, dir: "/team", packs: [{ manifest: { schema: 1, name: "team", summary: "Team rules.", settings: [signer] }, dir: "/team/packs/team" }] };
    const plan = resolveEngine([engine, team], { packs: ["team"] });
    const lines: string[] = [];
    const profile = { schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [team.ref], packs: ["team"], plan: "both", settings: {}, workflows: {} } satisfies ProfileFile;
    const code = settingsCommand([], { profileDir: "/profile", profile, plan, packs: [...engine.packs, ...team.packs], print: (line) => lines.push(line), apply: async () => 0 });
    expect(code).toBe(0);
    expect(lines.filter((line) => line.includes("identity.signer ="))).toEqual(["  identity.signer = 1password (default)"]);
    expect(lines).not.toContain("team:");
  });

  test("checks each value against its type, then pushes and applies it", async () => {
    const { home, pushed } = machineWithProfile();
    const result = await fleet(home, ["set", "pull-requests.freeReviews=4", "--set", "memory.repo=me/notes"]);
    expect(result.code).toBe(0);
    expect(pushed().settings).toEqual({ "pull-requests.freeReviews": 4, "memory.repo": "me/notes" });
    expect(result.output).toContain("✓ Saved pull-requests.freeReviews, memory.repo in your profile and pushed it.");
    expect(result.output).toContain("The memory pack is off, so its setting waits until you turn it on with fleet packs --add memory.");

    for (const [arg, message] of [
      ["pull-requests.freeReviews=many", "fleet set: pull-requests.freeReviews takes a number"],
      ["nope.key=1", "fleet set: nope.key: no pack has this setting."],
      ["freeReviews", "fleet set: freeReviews: write it as pack.key=value"],
    ]) {
      const refused = await fleet(home, ["set", arg!]);
      expect(refused.code).toBe(2);
      expect(refused.output).toStartWith(message!);
    }
    expect(pushed().settings).toEqual({ "pull-requests.freeReviews": 4, "memory.repo": "me/notes" });
  });
});
