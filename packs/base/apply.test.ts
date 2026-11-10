import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { main } from "../../src/cli.ts";
import { tempDirs } from "../../src/testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const engineRoot = join(import.meta.dir, "../..");
const launcher = join(engineRoot, "fleet");

function profileWith(settings: Record<string, unknown> = {}, dir = temp.make("profile-")) {
  const profile = { schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [], packs: [], plan: "both", settings, workflows: {} };
  writeFileSync(join(dir, "fleet.json"), JSON.stringify(profile));
  return dir;
}

async function fleet(args: string[], home: string): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const runFleetStepsOnly = async (command: string[]) => (command[1] === launcher ? (await fleet(command.slice(2), home)).code : 0);
  const code = await main(args, { home, engineRoot, platform: "linux", env: {}, print: (line) => lines.push(line), run: runFleetStepsOnly });
  return { code, output: lines.join("\n") };
}

type HookGroup = { hooks: Array<{ command: string }> };

function installedHook(home: string, provider: "claude" | "codex", event: string) {
  const config = provider === "claude" ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : parseToml(readFileSync(join(home, ".codex/config.toml"), "utf8"));
  const groups = (config.hooks as Record<string, HookGroup[] | undefined>)[event];
  if (!groups?.[0]?.hooks[0]) throw new Error(`${provider} has no ${event} hook`);
  return groups[0].hooks[0].command;
}

function addFixtureHook(home: string, event: string) {
  const dir = join(home, ".config/fleet/hooks", event);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture.ts"), 'process.stdout.write(`${Bun.argv[2]} saw ${await Bun.stdin.text()}`);\n');
}

async function fire(home: string, command: string, input: unknown) {
  const child = Bun.spawn(["sh", "-c", command], { env: { ...Bun.env, HOME: home }, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout };
}

describe("the Base pack's hook events", () => {
  test.each([
    ["claude", "SessionStart", { hook_event_name: "SessionStart", source: "startup" }],
    ["codex", "SessionStart", { hook_event_name: "SessionStart", source: "startup" }],
    ["codex", "PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }],
  ] as const)("a %s %s input reaches a pack's hook through the dispatcher", async (provider, event, input) => {
    const home = temp.make("home-");
    expect((await fleet(["apply", "--profile", profileWith()], home)).code).toBe(0);
    addFixtureHook(home, event);
    expect(await fire(home, installedHook(home, provider, event), input)).toEqual({ code: 0, stdout: `${provider} saw ${JSON.stringify(input)}` });
  });
});

describe("the settings snapshot", () => {
  const snapshotFile = (home: string) => join(home, ".local/state/fleet/settings.json");
  const snapshot = (home: string) => JSON.parse(readFileSync(snapshotFile(home), "utf8"));

  test("holds the resolved settings, readable only by the person, and follows a changed setting", async () => {
    const home = temp.make("home-");
    const profile = profileWith();
    expect((await fleet(["apply", "--profile", profile], home)).code).toBe(0);
    expect(snapshot(home)).toMatchObject({ "base.heavySlots": 2, "base.diskFloorGigabytes": 10 });
    expect(statSync(snapshotFile(home)).mode & 0o777).toBe(0o600);

    profileWith({ "base.heavySlots": 3 }, profile);
    expect((await fleet(["doctor"], home)).output).toContain("Step settings-snapshot of the base pack does not pass its check.");
    expect((await fleet(["apply"], home)).code).toBe(0);
    expect(snapshot(home)).toMatchObject({ "base.heavySlots": 3 });
    expect((await fleet(["doctor"], home)).output).not.toContain("settings-snapshot");
  });

  test("a snapshot that someone else can read is written again", async () => {
    const home = temp.make("home-");
    const profile = profileWith();
    await fleet(["apply", "--profile", profile], home);
    Bun.spawnSync(["chmod", "644", snapshotFile(home)]);
    expect((await fleet(["doctor"], home)).output).toContain("Step settings-snapshot of the base pack does not pass its check.");
    await fleet(["apply"], home);
    expect(statSync(snapshotFile(home)).mode & 0o777).toBe(0o600);
  });
});
