import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { fakeMachine, fleetSetup, machineFile, savedAnswers } from "./testing.ts";
import type { Machine } from "./commands.ts";
import { humanStep, packSignIn } from "./human.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const teamPack = {
  schema: 1,
  name: "posthog",
  summary: "Team repo prep and devboxes.",
  human: [{ id: "coder", say: "Sign in to Coder", command: "coder login", probe: ["coder", "whoami"] }],
  steps: [{ id: "devbox-start", run: ["hogli", "devbox:start"], check: ["hogli", "devbox:status"], after: "coder" }],
};

function teamSource(coder: { interactive?: true } = {}, manifest: typeof teamPack = teamPack): (ref: SourceRef) => Promise<FetchedSource> {
  const dir = temp.make("team-");
  mkdirSync(join(dir, "packs/posthog"), { recursive: true });
  writeFileSync(join(dir, "packs/posthog/pack.json"), JSON.stringify({ ...manifest, human: [{ ...teamPack.human[0], ...coder }] }));
  return async (ref) => ({ ref, dir, packs: await loadPacks(dir) });
}

describe("fleet setup sign-ins", () => {
  test("GitHub opens the device page, polls every 2 s with no key press, and asks for all four scopes", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, { github: 3 });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""], box);
    expect(result.code).toBe(0);
    expect(box.starts[0]).toEqual(["gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "repo,read:org,admin:public_key,admin:ssh_signing_key"]);
    expect(box.opened).toEqual(["https://github.com/login/device"]);
    expect(box.sleeps).toEqual([2000, 2000, 2000]);
    expect(result.prompts).toEqual(["Press ↵ to keep them, or e to change them: ", "  Go ahead? (Y/n) "]);
    expect(result.output).toContain("  Waiting for you. Nothing to press here: setup notices when you are done.");
    expect(result.output).toContain("  ✓ Sign in to GitHub: done");
  });

  test("GitHub refreshes a sign-in that lacks scopes, and a run without a person only lists it", async () => {
    const narrow = { scopes: "  - Token scopes: 'gist', 'read:org', 'repo'" };
    const first = temp.make("home-");
    const listed = fakeMachine(first, {}, narrow);
    const unattended = await fleetSetup(first, ["--non-interactive"], [], listed);
    expect(unattended.code).toBe(2);
    expect(unattended.output).toContain("  Sign in to GitHub: do it once in a terminal, then run fleet setup again");
    expect(listed.starts).toEqual([]);

    const home = temp.make("home-");
    const box = fakeMachine(home, {}, narrow);
    expect((await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""], box)).code).toBe(0);
    expect(box.starts[0]).toEqual(["gh", "auth", "refresh", "--hostname", "github.com", "--scopes", "repo,read:org,admin:public_key,admin:ssh_signing_key"]);
  });

  test("a member of the PostHog org gets its pack ticked, and the pack's sign-in runs its waiting steps", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, { coder: 1 }, { org: true });
    const result = await fleetSetup(home, ["--plan", "claude"], ["", "", ""], box, teamSource());
    expect(result.code).toBe(0);
    expect(result.output).toContain("  ✓ You are in the PostHog org, so the Posthog pack is ticked");
    expect(result.output).toContain("  1) Everyday  Pull requests, Orchestration, Communication, Posthog (default)");
    expect(savedAnswers(home).packs).toEqual(["pull-requests", "orchestration", "communication", "posthog"]);
    expect(savedAnswers(home).sources.map((source: SourceRef) => source.name)).toEqual(["agent-skills", "mattpocock-skills", "posthog"]);
    expect(box.starts).toContainEqual(["sh", "-c", "coder login"]);
    expect(box.runs).toEqual([]);
    expect(box.sleeps).toEqual([2000]);
    expect(box.calls.map((call) => call.command.join(" "))).toContain("hogli devbox:start");
    expect(machineFile(home).setup.done).toContain("human:posthog:coder");
  });

  test("a run without a person that picked packs before the GitHub sign-in still ticks the team pack the sign-in finds", async () => {
    const home = temp.make("home-");
    const args = ["--non-interactive", "--preset", "starter", "--plan", "claude"];
    expect((await fleetSetup(home, args, [], fakeMachine(home, { github: 1 }, { org: true }), teamSource())).code).toBe(2);
    expect(machineFile(home).setup.draft.packs).toEqual(["pull-requests"]);
    const box = fakeMachine(home, { coder: 1 }, { org: true });
    const result = await fleetSetup(home, args, [], box, teamSource());
    expect(result.output).toContain("  ✓ You are in the PostHog org, so the Posthog pack is ticked");
    expect(savedAnswers(home).packs).toEqual(["pull-requests", "posthog"]);
    expect(result.output).toContain("  Needs you: Sign in to Coder");
  });

  test("an interactive pack sign-in runs in the foreground with the keyboard, then its probe decides, with no polling", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, { coder: 50 }, { org: true });
    const result = await fleetSetup(home, ["--plan", "claude"], ["", "", ""], box, teamSource({ interactive: true }));
    expect(result.code).toBe(0);
    expect(box.runs).toEqual([{ command: ["sh", "-c", "coder login"], input: true }]);
    expect(box.starts.some((command) => command.join(" ").includes("coder login"))).toBe(false);
    expect(box.sleeps).toEqual([]);
    expect(result.output).toContain("  It needs your keyboard. Setup goes on when it ends.");
    expect(box.calls.map((call) => call.command.join(" "))).toContain("hogli devbox:start");

    const failedHome = temp.make("home-");
    const failed = fakeMachine(failedHome, { coder: 50 }, { org: true, failRun: true });
    const stopped = await fleetSetup(failedHome, ["--plan", "claude"], ["", "", ""], failed, teamSource({ interactive: true }));
    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain("fleet: sh -c coder login ended with code 1, but Sign in to Coder still does not pass its check.");
    expect(failed.calls.map((call) => call.command.join(" "))).not.toContain("hogli devbox:start");
  });

  test("a sign-in command that fails, or is missing, stops setup with what to do instead of waiting", async () => {
    const starter = ["--preset", "starter", "--plan", "claude"];
    const failedHome = temp.make("home-");
    const failed = await fleetSetup(failedHome, starter, ["", ""], fakeMachine(failedHome, { claude: 50 }, { exits: { claude: 1 } }));
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("fleet: claude auth login ended with code 1, but Sign in to Claude still does not pass its check. Fix what it says above, then run fleet setup again.");

    const missingHome = temp.make("home-");
    const missing = await fleetSetup(missingHome, starter, ["", ""], fakeMachine(missingHome, { claude: 50 }, { exits: { claude: 127 } }));
    expect(missing.output).toContain("fleet: claude is not installed here. Install it, then run fleet setup again.");

    const quietHome = temp.make("home-");
    const box = fakeMachine(quietHome, { claude: 50 }, { exits: { claude: 0 } });
    const quiet = await fleetSetup(quietHome, starter, ["", ""], box);
    expect(quiet.output).toContain("fleet: claude auth login ended, but Sign in to Claude still does not pass its check.");
    expect(box.sleeps).toHaveLength(16);
  });

  test("GitHub sets up Git's credentials before a team pack is fetched, and checks the active account", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, {}, { org: true });
    expect((await fleetSetup(home, ["--plan", "claude"], ["", "", ""], box, teamSource())).code).toBe(0);
    const lines = box.calls.map((call) => call.command.join(" "));
    expect(lines).toContain("gh auth status --active --hostname github.com");
    expect(lines.indexOf("gh auth setup-git")).toBeLessThan(lines.findIndex((line) => line.startsWith("gh api user/memberships")));
  });

  test("a rerun fetches a team pack whose cache is gone, and --remove takes a team pack before it is found", async () => {
    const home = temp.make("home-");
    const fetch = teamSource();
    const stopped = await fleetSetup(home, ["--plan", "claude"], [], fakeMachine(home, {}, { org: true }), fetch);
    expect(stopped.code).toBe(130);
    expect(machineFile(home).setup.done).toContain("github");
    const fetched: string[] = [];
    const resumed = await fleetSetup(home, ["--plan", "claude"], ["", "", ""], fakeMachine(home, { coder: 1 }, { org: true }), async (ref) => (fetched.push(ref.name), fetch(ref)));
    expect(resumed.code).toBe(0);
    expect(fetched).toEqual(["posthog"]);
    expect(machineFile(home).setup.done).toContain("human:posthog:coder");

    const removed = temp.make("home-");
    const result = await fleetSetup(removed, ["--remove", "posthog", "--plan", "claude"], ["", "", ""], fakeMachine(removed, {}, { org: true }), teamSource());
    expect(result.code).toBe(0);
    expect(savedAnswers(removed).packs).not.toContain("posthog");
  });

  test("a first run takes --set and --workflows for a team pack that GitHub sign-in finds, and refuses them, saving nothing, when no team has them", async () => {
    const withChoices = {
      ...teamPack,
      workflows: [{ id: "team-reviews", name: "Reviews", sentence: "Pull requests get a team review.", default: true }],
      settings: [
        { key: "posthog.region", question: "Which region?", type: "choice", default: "us", ask: "setup", choices: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }] },
        { key: "posthog.mirror", question: "Which mirror?", type: "string", default: "main", ask: "never" },
      ],
    };
    const args = ["--set", "posthog.region=eu", "--set", "posthog.mirror=edge", "--set", "pull-requests.freeReviews=5", "--workflows", "team-reviews=off", "--plan", "claude"];
    const home = temp.make("home-");
    const member = await fleetSetup(home, args, ["", "", ""], fakeMachine(home, { coder: 1 }, { org: true }), teamSource({}, withChoices as typeof teamPack));
    expect([member.code, member.output.split("\n").filter((line) => line.startsWith("fleet setup:"))]).toEqual([0, []]);
    expect(savedAnswers(home)).toMatchObject({
      packs: expect.arrayContaining(["posthog"]),
      settings: { "posthog.region": "eu", "posthog.mirror": "edge", "pull-requests.freeReviews": 5 },
      workflows: { "team-reviews": false },
    });

    const outside = temp.make("home-");
    const refused = await fleetSetup(outside, args, ["", "", ""], fakeMachine(outside, {}, { org: false }), teamSource({}, withChoices as typeof teamPack));
    expect(refused.code).toBe(2);
    expect(refused.output).toContain("fleet setup: --workflows: no workflow named team-reviews");
    expect(refused.prompts).toEqual([]);
    expect(machineFile(outside).setup.draft.settings).toBeUndefined();
  });

  test("a run without a person changes nothing for a sign-in while answers are missing", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "devbox" }));
    const box = fakeMachine(home, {}, { org: true });
    const result = await fleetSetup(home, ["--non-interactive", "--preset", "everything"], [], box, teamSource());
    expect(result.code).toBe(2);
    expect(result.output).toContain("  --set orchestration.loopProject=<value>");
    expect(box.calls.map((call) => call.command.join(" "))).not.toContain("hogli devbox:start");
  });

  test("Claude and ChatGPT advance on their probes, only for the chosen plans, and the ChatGPT probe is isolated", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, { claude: 1, chatgpt: 2 });
    const result = await fleetSetup(home, ["--preset", "starter"], ["", "", ""], box);
    expect(result.code).toBe(0);
    expect(box.starts.slice(-2)).toEqual([["claude", "auth", "login"], ["codex", "login"]]);
    const probes = box.calls.filter((call) => call.command[0] === "codex");
    expect(probes.length).toBeGreaterThan(1);
    for (const probe of probes) {
      expect(probe.command.slice(0, 7)).toEqual(["codex", "exec", "--ephemeral", "--sandbox", "read-only", "--ignore-user-config", "--skip-git-repo-check"]);
      expect(probe.command).toContain("gpt-6.1-sol");
      expect(probe.timeoutMs).toBe(20000);
      expect(probe.cwd!.startsWith(home)).toBe(false);
      expect(existsSync(probe.cwd!)).toBe(false);
    }
    expect(existsSync(join(home, ".codex"))).toBe(false);

    const other = temp.make("home-");
    const claudeOnly = fakeMachine(other, { claude: 1, chatgpt: 1 });
    await fleetSetup(other, ["--preset", "starter", "--plan", "claude"], ["", ""], claudeOnly);
    expect(claudeOnly.calls.some((call) => call.command[0] === "codex")).toBe(false);
  });
});

describe("a pack's sign-in", () => {
  const killed = 143;

  function backgroundCommand(applied: string) {
    let saved = false;
    let end = (_code: number) => {};
    const exited = new Promise<number>((resolve) => (end = resolve));
    let code: number | undefined;
    void exited.then((exit) => (code = exit));
    const lines: string[] = [];
    const machine = {
      exec: async (command: string[]) => ({ code: command.at(-1) === "whoami" && saved ? 0 : 1, output: "" }),
      start: () => ({ stop: () => end(killed), exited }),
      sleep: async () => void (saved = true),
      openUrl: async () => {},
    } as unknown as Machine;
    const context = { terminal: { print: (line: string) => void lines.push(line), ask: async () => "" }, machine, nonInteractive: false };
    const runToEnd = () => {
      if (code !== undefined) return;
      writeFileSync(applied, "applied");
      end(0);
    };
    return { context, runToEnd, exit: () => code, output: () => lines.join("\n") };
  }

  const settle = async () => {
    for (let tick = 0; tick < 50; tick++) await Promise.resolve();
  };

  test("lets its fleet repair command run to its end once the check passes, so the command's own apply completes", async () => {
    const applied = join(temp.make("repair-"), "applied");
    const command = backgroundCommand(applied);
    const human = { id: "login", pack: "team", say: "Sign in.", command: "fleet login", probe: ["fleet", "whoami"] };
    const running = humanStep(packSignIn(human, [], command.context, "/engine"), command.context).run();
    await settle();
    expect(command.output()).not.toContain("✓ Sign in.: done");
    command.runToEnd();
    await running;
    expect([existsSync(applied), command.exit()]).toEqual([true, 0]);
    expect(command.output()).toContain("✓ Sign in.: done");
  });

  test("stops a background command that is not a fleet command once the check passes, and finishes the step", async () => {
    const command = backgroundCommand(join(temp.make("tunnel-"), "applied"));
    const human = { id: "tunnel", pack: "team", say: "Open the tunnel.", command: "t3 connect --keep-running", probe: ["t3", "whoami"] };
    void humanStep(packSignIn(human, [], command.context, "/engine"), command.context).run();
    await settle();
    expect([command.output().includes("✓ Open the tunnel.: done"), command.exit()]).toEqual([true, killed]);
  });

  test("runs this engine's launcher for a leading fleet in its probe, command, and steps", async () => {
    const calls: string[] = [];
    let started = false;
    const machine = {
      async exec(command: string[]) {
        calls.push(command.join(" "));
        const status = command.at(-1) === "status";
        return { code: status && !started ? 1 : 0, output: "" };
      },
    } as unknown as Machine;
    const human = { id: "login", pack: "team", say: "Sign in.", command: "fleet login --web", probe: ["fleet", "whoami"] };
    const steps = [{ id: "start", pack: "team", run: ["fleet", "start"], check: ["fleet", "status"], after: "login" }];
    const signIn = packSignIn(human, steps, { terminal: { print() {}, ask: async () => "" }, machine, nonInteractive: false }, "/engine");
    expect(signIn.command).toEqual(["sh", "-c", "/bin/sh '/engine/fleet' login --web"]);
    await signIn.probe();
    const run = machine.exec.bind(machine);
    machine.exec = async (command: string[]) => (command.at(-1) === "start" && (started = true), run(command));
    await signIn.after!();
    expect(calls).toEqual(["/bin/sh /engine/fleet whoami", "/bin/sh /engine/fleet status", "/bin/sh /engine/fleet start", "/bin/sh /engine/fleet status"]);
  });

  test("an interactive one reads the keyboard through a pseudo-terminal while setup's own input is not the terminal", async () => {
    const dir = temp.make("tty-");
    const token = join(dir, "token");
    let screen = "";
    const harness = join(import.meta.dir, "fixtures/interactive-step.ts");
    const child = Bun.spawn(["sh", "-c", 'exec "$0" "$1" "$2" </dev/null', process.execPath, harness, token], { terminal: { cols: 100, rows: 30, data: (_, bytes) => void (screen += new TextDecoder().decode(bytes)) } });
    try {
      child.terminal!.write("s3cret\n");
      expect(await child.exited).toBe(0);
    } finally {
      child.kill();
      child.terminal!.close();
    }
    expect(readFileSync(token, "utf8")).toBe("s3cret");
    expect(screen).toContain("✓ Sign in to the team service: done");
    expect(screen).toContain("sleeps=0");
  });
});
