import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { loadPacks } from "../pack/manifest.ts";
import type { FetchedSource, PackSetting, SourceRef } from "../pack/types.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { parseSetupFlags } from "./flags.ts";
import { profilePath } from "./profile.ts";
import { packList, settingSteps, type Catalog, type Draft } from "./questions.ts";
import { engineRoot, fakeMachine, githubRepo, pushedAnswers, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const region: PackSetting = {
  key: "team.region",
  question: "Where should your devbox run?",
  type: "choice",
  choices: [
    { value: "us", label: "US" },
    { value: "eu", label: "EU" },
  ],
  default: "us",
  defaultByTimeZone: { "Europe/": "eu", "America/": "us" },
  ask: "setup",
};

const teamRegion: PackSetting = { ...region, key: "posthog.region" };

function teamSource(settings: PackSetting[]): (ref: SourceRef) => Promise<FetchedSource> {
  const dir = temp.make("team-");
  mkdirSync(join(dir, "packs/posthog"), { recursive: true });
  writeFileSync(join(dir, "packs/posthog/pack.json"), JSON.stringify({ schema: 1, name: "posthog", summary: "Team rules.", settings }));
  return async (ref) => ({ ref, dir, packs: await loadPacks(dir) });
}

async function unattendedSetup(home: string, timeZone: string, { settings = [teamRegion], plan = "claude" } = {}) {
  const io = scripted([]);
  const box = fakeMachine(home, {}, { org: true });
  return main(["setup", "--non-interactive", "--preset", "starter", "--plan", plan, "--devbox", "skip"], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: box.machine, clock: box.clock, doctor: async () => 0, env: {}, timeZone, fetchSource: teamSource(settings) } });
}

async function pushFromAnotherMachine(home: string, settings: Record<string, string>) {
  const other = temp.make("other-");
  await spawnGit(other, "clone", "-q", githubRepo(home, "nora/fleet-profile"), ".");
  const file = JSON.parse(readFileSync(join(other, "fleet.json"), "utf8"));
  writeFileSync(join(other, "fleet.json"), JSON.stringify({ ...file, settings: { ...file.settings, ...settings } }, null, 2) + "\n");
  await spawnGit(other, "commit", "-q", "-am", "Elsewhere");
  await spawnGit(other, "push", "-q");
}

async function ask(timeZone: string | undefined, args: string[] = []) {
  const lines: string[] = [];
  const draft: Draft = {};
  const terminal = { print: (line: string) => void lines.push(line), ask: async () => "" };
  const context = { terminal, flags: parseSetupFlags(args), catalog: {} as Catalog, draft, timeZone, answer: async (fields: Draft) => void Object.assign(draft, fields) };
  await settingSteps(context, [region])[0]!.run();
  return { settings: draft.settings, output: lines.join("\n") };
}

describe("a setting's time-zone default", () => {
  test("picks eu in Europe/Berlin", async () => {
    const result = await ask("Europe/Berlin");
    expect(result.output).toContain("  2) EU (default)");
    expect(result.settings).toEqual({ "team.region": "eu" });
  });

  test("picks us in America/New_York", async () => {
    expect((await ask("America/New_York")).settings).toEqual({ "team.region": "us" });
  });

  test("falls back to the static default in a zone the map does not name", async () => {
    const result = await ask("Asia/Tokyo");
    expect(result.output).toContain("  1) US (default)");
    expect(result.settings).toEqual({ "team.region": "us" });
  });

  test("--non-interactive saves the time-zone default to the pushed profile", async () => {
    const home = temp.make("home-");
    expect(await unattendedSetup(home, "Europe/Lisbon")).toBe(0);
    expect((await pushedAnswers(home)).settings).toEqual({ "posthog.region": "eu" });
  });

  test("--non-interactive on another machine keeps the region the profile already has", async () => {
    const home = temp.make("home-");
    expect(await unattendedSetup(home, "America/New_York")).toBe(0);
    rmSync(join(home, ".config/fleet"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });
    expect(await unattendedSetup(home, "Europe/Lisbon")).toBe(0);
    expect((await pushedAnswers(home)).settings).toEqual({ "posthog.region": "us" });
  });

  test("--non-interactive on a machine with a profile saves the time-zone default of a setting the profile lacks", async () => {
    const home = temp.make("home-");
    expect(await unattendedSetup(home, "Europe/Lisbon", { settings: [] })).toBe(0);
    expect(await unattendedSetup(home, "Europe/Lisbon", { plan: "both" })).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ plan: "both", settings: { "posthog.region": "eu" } });
  });

  test("--non-interactive on a machine whose profile clone is behind keeps the region another machine pushed", async () => {
    const home = temp.make("home-");
    expect(await unattendedSetup(home, "Europe/Lisbon", { settings: [] })).toBe(0);
    await pushFromAnotherMachine(home, { "posthog.region": "us" });
    expect(await unattendedSetup(home, "Europe/Lisbon", { plan: "both" })).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ plan: "both", settings: { "posthog.region": "us" } });
  });

  test("treats a machine without a time zone as one the map does not name", async () => {
    const result = await ask(undefined);
    expect(result.output).toContain("  1) US (default)");
    expect(result.settings).toEqual({ "team.region": "us" });
  });
});

describe("a pack's name in setup", () => {
  test("is its title, or its capitalised name without one", () => {
    const packs = [{ dir: "/team/packs/posthog", manifest: { schema: 1 as const, name: "posthog", title: "PostHog", summary: "Team rules." } }, { dir: "/packs/memory", manifest: { schema: 1 as const, name: "memory", summary: "Memory." } }];
    expect(packList(["posthog", "memory", "later"], { packs } as Catalog)).toBe("PostHog, Memory, later");
  });
});
