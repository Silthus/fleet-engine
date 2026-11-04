import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Owned, PackJob, Plan } from "../../pack/types.ts";
import { apply, check } from "../../reconciler/apply.ts";
import { tempDirs } from "../../testing/git.ts";
import type { CommandRunner } from "../run.ts";
import { jobsAdapter, type FleetTask, type T3Tasks } from "./adapter.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const engine = "/opt/fleet-engine";

function plan(os: "darwin" | "linux", jobs: Array<PackJob & { pack?: string }>): Plan {
  return {
    machine: { schema: 1, role: os === "darwin" ? "mac" : "devbox" },
    os,
    ai: "both",
    packs: [{ name: "base", source: "engine", ref: "main", available: true }],
    workflows: [],
    files: [],
    config: [],
    owners: {},
    jobs: jobs.map((job) => ({ pack: "base", ...job }) as Owned<PackJob>),
    human: [],
    steps: [],
    checks: [],
    commands: {},
    settings: {},
    unanswered: [],
    dropped: [],
  };
}

const prune: PackJob = { id: "prune", command: ["fleet", "prune", "--auto"], schedule: { every: "1d", at: "03:17" } };
const pull: PackJob = { id: "skills-pull", command: ["git", "-C", "/home/u/skills", "pull"], schedule: { every: "5m" } };

function crontab(initial: string | undefined) {
  const state = { text: initial, writes: 0 };
  const run: CommandRunner = async (command, options) => {
    if (command.join(" ") === "crontab -l") return state.text === undefined ? { code: 1, stdout: "", stderr: "no crontab for user\n" } : { code: 0, stdout: state.text };
    if (command.join(" ") === "crontab -") {
      state.text = options?.input;
      state.writes++;
      return { code: 0, stdout: "" };
    }
    return { code: 127, stdout: "" };
  };
  return { state, adapter: jobsAdapter({ run, engineRoot: engine }) };
}

describe("cron jobs on Linux", () => {
  test("adds marked lines that run launcher scripts, and keeps foreign lines", async () => {
    const home = temp.make("home-");
    const foreign = "MAILTO=me\n0 * * * * /usr/bin/backup # nightly backup\n";
    const cron = crontab(foreign);

    await apply(plan("linux", [prune, pull]), { home, adapters: [cron.adapter] });

    const jobs = `${home}/.local/state/fleet/jobs`;
    expect(cron.state.text).toBe(foreign + `17 3 * * * /bin/sh '${jobs}/prune.sh' # fleet:prune\n` + `*/5 * * * * /bin/sh '${jobs}/skills-pull.sh' # fleet:skills-pull\n`);
    expect(readFileSync(join(jobs, "prune.sh"), "utf8")).toBe(
      `#!/bin/sh\nPATH='${home}/.local/bin:${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin'\nexport PATH\nexec '/bin/sh' '${engine}/fleet' 'prune' '--auto' >>'${jobs}/prune.log' 2>&1\n`,
    );
  });

  test("a launcher finds tools on Fleet's PATH and passes odd arguments through unchanged", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/echo-args"), '#!/bin/sh\nprintf "%s|" "$@"\n');
    chmodSync(join(home, ".local/bin/echo-args"), 0o755);
    const odd: PackJob = { id: "odd", command: ["echo-args", "50%", "a\\%b", "two\nlines", "it's"], schedule: { every: "15m" } };
    const cron = crontab("");

    await apply(plan("linux", [odd]), { home, adapters: [cron.adapter] });

    expect(cron.state.text).toBe(`*/15 * * * * /bin/sh '${home}/.local/state/fleet/jobs/odd.sh' # fleet:odd\n`);
    const ran = Bun.spawnSync(["/bin/sh", join(home, ".local/state/fleet/jobs/odd.sh")], { env: { PATH: "/nonexistent" } });
    expect(ran.exitCode).toBe(0);
    expect(readFileSync(join(home, ".local/state/fleet/jobs/odd.log"), "utf8")).toBe("50%|a\\%b|two\nlines|it's|");
  });

  test("puts back a missing launcher folder, and doctor sees it first", async () => {
    const home = temp.make("home-");
    const cron = crontab("");
    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    rmSync(join(home, ".local/state/fleet/jobs"), { recursive: true });

    const report = await check(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    expect(report.findings).toContainEqual({ id: "job:skills-pull", pack: "base", say: "The skills-pull job needs to be updated.", repair: "apply" });

    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    expect(existsSync(join(home, ".local/state/fleet/jobs/skills-pull.sh"))).toBe(true);
    expect(cron.state.writes).toBe(1);
    expect((await check(plan("linux", [pull]), { home, adapters: [cron.adapter] })).ok).toBe(true);
  });

  test("a rerun changes nothing, and a dropped job loses only its own line", async () => {
    const home = temp.make("home-");
    const cron = crontab("0 * * * * /usr/bin/backup\n");
    await apply(plan("linux", [prune, pull]), { home, adapters: [cron.adapter] });
    await apply(plan("linux", [prune, pull]), { home, adapters: [cron.adapter] });
    expect(cron.state.writes).toBe(1);

    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });

    expect(cron.state.text).toStartWith("0 * * * * /usr/bin/backup\n*/5 * * * * ");
    expect(cron.state.text).not.toContain("fleet:prune");
    expect(existsSync(join(home, ".local/state/fleet/jobs/prune.sh"))).toBe(false);
  });

  test("a duplicate marked line goes, and the launcher of the line that stays is kept", async () => {
    const home = temp.make("home-");
    const cron = crontab("");
    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    const line = cron.state.text!;
    cron.state.text = line + line;

    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    expect(cron.state.text).toBe(line);
    expect(existsSync(join(home, ".local/state/fleet/jobs/skills-pull.sh"))).toBe(true);

    cron.state.text = line + line;
    const offline = { ...plan("linux", []), packs: [{ name: "base", source: "engine", ref: "main", available: true }, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };
    await apply(offline, { home, adapters: [cron.adapter] });
    expect(cron.state.text).toBe(line);
    expect(existsSync(join(home, ".local/state/fleet/jobs/skills-pull.sh"))).toBe(true);
  });

  test("starts a crontab when the user has none, with no T3 precondition", async () => {
    const home = temp.make("home-");
    const cron = crontab(undefined);
    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    expect(cron.state.text).toEndWith("# fleet:skills-pull\n");
    expect(existsSync(join(home, ".t3"))).toBe(false);
  });

  test("writes nothing when crontab cannot be read", async () => {
    const home = temp.make("home-");
    const run: CommandRunner = async (command) => (command[1] === "-l" ? { code: 1, stdout: "", stderr: "permission denied\n" } : { code: 0, stdout: "" });
    const writes: string[][] = [];
    const report = await apply(plan("linux", [pull]), { home, adapters: [jobsAdapter({ run: async (command, options) => (writes.push(command), run(command, options)), engineRoot: engine })] });
    expect(writes).toEqual([["crontab", "-l"]]);
    expect(report.findings).toContainEqual({ id: "jobs:cron", pack: "engine", say: "Could not read your crontab (permission denied), so jobs were not changed.", repair: "human" });
  });

  test("doctor reports a missing job without writing", async () => {
    const home = temp.make("home-");
    const cron = crontab("");
    const report = await check(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({ id: "job:skills-pull", pack: "base", say: "The skills-pull job needs to be added.", repair: "apply" });
    expect(cron.state.writes).toBe(0);
  });
});

describe("a pack source that cannot be fetched", () => {
  test("keeps every fleet cron line, agent, and task until the source is back", async () => {
    const home = temp.make("home-");
    const cron = crontab("");
    await apply(plan("linux", [prune, pull]), { home, adapters: [cron.adapter] });
    const offline = { ...plan("linux", [pull]), packs: [{ name: "base", source: "engine", ref: "main", available: true }, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };
    await apply(offline, { home, adapters: [cron.adapter] });
    expect(cron.state.text).toContain("# fleet:prune");
  });
});

describe("launchd jobs on a Mac", () => {
  function launchctl(stuck = false) {
    const calls: string[][] = [];
    const loaded = new Set<string>();
    const mode = { stuck, printFails: false };
    const run: CommandRunner = async (command) => {
      calls.push(command);
      const [, verb, target] = command;
      if (verb === "print") return mode.printFails ? { code: 127, stdout: "" } : { code: loaded.has(target!) ? 0 : 113, stdout: "" };
      if (verb === "bootstrap") loaded.add(`gui/501/${command[3]!.split("/").at(-1)!.replace(/\.plist$/, "")}`);
      if (verb === "bootout") {
        if (mode.stuck) return { code: 5, stdout: "" };
        loaded.delete(target!);
      }
      return { code: 0, stdout: "" };
    };
    return { calls, loaded, mode, adapter: jobsAdapter({ run, engineRoot: engine, uid: 501 }) };
  }

  test("writes a dev.fleet plist that runs the launcher script, and loads it", async () => {
    const home = temp.make("home-");
    const mac = launchctl();

    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });

    const path = join(home, "Library/LaunchAgents/dev.fleet.prune.plist");
    expect(readFileSync(path, "utf8")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.fleet.prune</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${home}/.local/state/fleet/jobs/prune.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${home}/.local/state/fleet/jobs/prune.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/.local/state/fleet/jobs/prune.log</string>
</dict>
</plist>
`);
    expect(mac.loaded.has("gui/501/dev.fleet.prune")).toBe(true);
    expect(readFileSync(join(home, ".local/state/fleet/jobs/prune.sh"), "utf8")).toContain(`PATH='${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'`);
  });

  test("keeps an agent that launchd does not stop", async () => {
    const home = temp.make("home-");
    const mac = launchctl(true);
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });

    const report = await apply(plan("darwin", []), { home, adapters: [mac.adapter] });

    expect(existsSync(join(home, "Library/LaunchAgents/dev.fleet.prune.plist"))).toBe(true);
    expect(report.findings).toContainEqual({ id: "job:prune", pack: "engine", say: "launchd did not stop the prune job, so Fleet left its agent as it is.", repair: "apply" });
  });

  test("keeps an agent and its launcher when launchd cannot say whether the agent stopped", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    mac.mode.stuck = true;
    mac.mode.printFails = true;

    const report = await apply(plan("darwin", []), { home, adapters: [mac.adapter] });

    expect(existsSync(join(home, "Library/LaunchAgents/dev.fleet.prune.plist"))).toBe(true);
    expect(existsSync(join(home, ".local/state/fleet/jobs/prune.sh"))).toBe(true);
    expect(report.actions).toEqual([]);
    expect(report.findings).toContainEqual({ id: "job:prune", pack: "engine", say: "Could not check that launchd stopped the prune job (launchctl print exit 127), so Fleet left its agent as it is.", repair: "apply" });
  });

  test("keeps the old launcher when launchd does not stop the agent it would update", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    const launcher = readFileSync(join(home, ".local/state/fleet/jobs/prune.sh"), "utf8");
    mac.mode.stuck = true;

    const report = await apply(plan("darwin", [{ ...prune, command: ["fleet", "prune"], schedule: { every: "5m" } }]), { home, adapters: [mac.adapter] });

    expect(readFileSync(join(home, ".local/state/fleet/jobs/prune.sh"), "utf8")).toBe(launcher);
    expect(report.findings.map((finding) => finding.say)).toContain("launchd did not stop the prune job, so Fleet left its agent as it is.");
  });

  test("reads the Label of the plist itself, not one nested inside it", async () => {
    const home = temp.make("home-");
    const agents = join(home, "Library/LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const theirs = "<plist><dict><key>EnvironmentVariables</key><dict><key>Label</key><string>dev.fleet.prune</string></dict><key>Label</key><string>com.example.backup</string></dict></plist>";
    writeFileSync(join(agents, "dev.fleet.prune.plist"), theirs);
    const mac = launchctl();

    const report = await apply(plan("darwin", []), { home, adapters: [mac.adapter] });

    expect(readFileSync(join(agents, "dev.fleet.prune.plist"), "utf8")).toBe(theirs);
    expect(report.findings.map((finding) => finding.say)).toContain("Left Library/LaunchAgents/dev.fleet.prune.plist alone: its Label is com.example.backup, not dev.fleet.prune.");
  });

  test("leaves a dev.fleet plist with another Label alone", async () => {
    const home = temp.make("home-");
    const agents = join(home, "Library/LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const theirs = "<plist><dict><key>Label</key><string>com.example.prune</string></dict></plist>";
    writeFileSync(join(agents, "dev.fleet.prune.plist"), theirs);
    const mac = launchctl();

    const kept = await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    const left = await apply(plan("darwin", []), { home, adapters: [mac.adapter] });

    expect(readFileSync(join(agents, "dev.fleet.prune.plist"), "utf8")).toBe(theirs);
    expect(mac.calls.filter((call) => call[1] !== "print")).toEqual([]);
    const say = "Left Library/LaunchAgents/dev.fleet.prune.plist alone: its Label is com.example.prune, not dev.fleet.prune.";
    expect(kept.findings).toContainEqual({ id: "job:prune", pack: "base", say, repair: "human" });
    expect(left.findings).toContainEqual({ id: "job:prune", pack: "engine", say, repair: "human" });
  });

  test("uses an interval for frequent jobs, reruns without reloading, and removes only its own agents", async () => {
    const home = temp.make("home-");
    const agents = join(home, "Library/LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "com.example.backup.plist"), "<plist/>");
    const mac = launchctl();

    await apply(plan("darwin", [pull, prune]), { home, adapters: [mac.adapter] });
    expect(readFileSync(join(agents, "dev.fleet.skills-pull.plist"), "utf8")).toContain("<key>StartInterval</key>\n  <integer>300</integer>");
    const before = mac.calls.length;
    await apply(plan("darwin", [pull, prune]), { home, adapters: [mac.adapter] });
    expect(mac.calls.slice(before).filter((call) => call[1] !== "print")).toEqual([]);

    await apply(plan("darwin", [pull]), { home, adapters: [mac.adapter] });
    expect(readdirSync(agents).sort()).toEqual(["com.example.backup.plist", "dev.fleet.skills-pull.plist"]);
    expect(mac.calls).toContainEqual(["launchctl", "bootout", "gui/501/dev.fleet.prune"]);
  });
});

describe("another home directory", () => {
  test("leaves the user's cron alone when HOME is not their home and no runner is given", async () => {
    const home = temp.make("home-");
    const report = await apply(plan("linux", [pull]), { home, adapters: [jobsAdapter({ engineRoot: engine })] });
    expect(report.findings).toContainEqual({ id: "jobs:home", pack: "engine", say: `Left jobs alone: ${home} is not your home directory, and cron and launchd belong to your user.` });
    expect(report.actions).toEqual([]);
  });
});

describe("T3 scheduled tasks", () => {
  const loop: PackJob = {
    id: "quality-loop",
    command: [],
    schedule: { every: "1d", at: "02:30" },
    runner: "t3",
    workflow: "quality-loop",
    task: { prompt: "Run the quality-loop skill.", projectSetting: "orchestration.loopProject", modelRole: "implementation", workspaceStrategy: "worktree", runtimeMode: "full-access", project: "/home/u/app" },
  };
  const wanted: FleetTask = {
    id: "fleet:quality-loop",
    title: "Fleet: quality-loop",
    prompt: "Run the quality-loop skill.",
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "02:30" },
    project: "/home/u/app",
    modelRole: "implementation",
    workspaceStrategy: "worktree",
    runtimeMode: "full-access",
  };

  function server(initial: FleetTask[] = []) {
    const tasks = new Map(initial.map((task) => [task.id, task]));
    const calls: string[] = [];
    const client: T3Tasks = {
      list: async () => [...tasks.values()],
      upsert: async (task) => void (calls.push(`upsert ${task.id}`), tasks.set(task.id, task)),
      setEnabled: async (id, enabled) => void (calls.push(`enable ${id} ${enabled}`), tasks.set(id, { ...tasks.get(id)!, enabled })),
    };
    return { tasks, calls, adapter: jobsAdapter({ run: async () => ({ code: 0, stdout: "" }), engineRoot: engine, t3: async () => client }) };
  }

  test("creates the task once through the T3 server", async () => {
    const home = temp.make("home-");
    const t3 = server();
    await apply(plan("linux", [loop]), { home, adapters: [t3.adapter] });
    await apply(plan("linux", [loop]), { home, adapters: [t3.adapter] });
    expect(t3.tasks.get("fleet:quality-loop")).toEqual(wanted);
    expect(t3.calls).toEqual(["upsert fleet:quality-loop"]);
  });

  test("disables a fleet task whose workflow is off, and leaves the user's tasks alone", async () => {
    const home = temp.make("home-");
    const mine = { ...wanted, id: "my-digest", title: "My digest" };
    const t3 = server([wanted, mine]);
    await apply(plan("linux", []), { home, adapters: [t3.adapter] });
    expect(t3.tasks.get("fleet:quality-loop")?.enabled).toBe(false);
    expect(t3.tasks.get("my-digest")?.enabled).toBe(true);
    expect(t3.calls).toEqual(["enable fleet:quality-loop false"]);
  });

  test("reports tasks as pending when no T3 server answers", async () => {
    const home = temp.make("home-");
    const adapter = jobsAdapter({ run: async () => ({ code: 0, stdout: "" }), engineRoot: engine, t3: async () => undefined });
    const report = await check(plan("linux", [loop]), { home, adapters: [adapter] });
    expect(report.findings).toContainEqual({ id: "task:quality-loop", pack: "base", say: "The quality-loop task waits for T3 Code to run. The next fleet apply after T3 Code starts adds it.", repair: "apply" });
  });
});
