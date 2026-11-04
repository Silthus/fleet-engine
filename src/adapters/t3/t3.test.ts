import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigEntry, Owned, PackJob, Plan } from "../../pack/types.ts";
import { apply, check } from "../../reconciler/apply.ts";
import { tempDirs } from "../../testing/git.ts";
import { engineAdapters } from "../index.ts";
import type { FleetTask } from "../jobs/adapter.ts";
import { jobsAdapter } from "../jobs/adapter.ts";
import type { CommandRunner } from "../run.ts";
import { seedT3, t3Adapter } from "./adapter.ts";
import type { T3Rpc, T3Server } from "./port.ts";
import { t3Tasks } from "./tasks.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const settingsFile = ".t3/userdata/settings.json";
const desktopFile = ".t3/userdata/desktop-settings.json";
const engine = "/opt/fleet-engine";
const project = "/work/app";
const fastModel = { instanceId: "codex", model: "gpt-fast" };

const entry = (key: string, value: unknown, pack = "base"): Owned<ConfigEntry> => ({ provider: "t3", key, value, pack });

const loop: Owned<PackJob> = {
  id: "quality-loop",
  pack: "orchestration",
  command: [],
  schedule: { every: "1d", at: "02:30" },
  runner: "t3",
  task: { prompt: "Run the quality-loop skill.", projectSetting: "orchestration.loopProject", modelRole: "implementation", workspaceStrategy: "worktree", runtimeMode: "full-access", project },
};

const wantedTask: FleetTask = {
  id: "fleet:quality-loop",
  title: "Fleet: quality-loop",
  prompt: "Run the quality-loop skill.",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "02:30" },
  project,
  modelRole: "implementation",
  workspaceStrategy: "worktree",
  runtimeMode: "full-access",
};

function plan(os: "darwin" | "linux", config: Array<Owned<ConfigEntry>>, jobs: Array<Owned<PackJob>> = []): Plan {
  return {
    machine: { schema: 1, role: os === "darwin" ? "mac" : "devbox" },
    os,
    ai: "both",
    packs: [{ name: "base", source: "engine", ref: "main", available: true }],
    workflows: [],
    files: [],
    config,
    owners: {},
    jobs,
    human: [],
    steps: [],
    checks: [],
    commands: {},
    settings: {},
    unanswered: [],
    dropped: [],
  };
}

const base = [entry("defaultThreadEnvMode", "worktree"), entry("sidebarAutoSettleAfterDays", 3), entry("storageCleanup", { worktreeOnMerge: true, logsAfterDays: 14 })];

const read = (home: string, target: string) => JSON.parse(readFileSync(join(home, target), "utf8"));
const write = (home: string, target: string, value: unknown) => {
  mkdirSync(join(home, target, ".."), { recursive: true });
  writeFileSync(join(home, target), `${JSON.stringify(value, null, 2)}\n`);
};
const backups = (home: string) => (existsSync(join(home, ".local/state/fleet/backups")) ? readdirSync(join(home, ".local/state/fleet/backups")) : []);

type Link = { environmentId: string; label: string; status: "reachable" | "unreachable" | "expired"; lastError: string | null };
type StoredTask = Record<string, unknown> & { id: string; enabled: boolean };

function fakeServer(options: { up?: boolean; settings?: Record<string, unknown>; links?: Link[]; projects?: string[]; ignorePatch?: boolean } = {}) {
  const defaults = { defaultThreadEnvMode: "local", sidebarAutoSettleAfterDays: 7, storageCleanup: { worktreeOnMerge: false, logsAfterDays: 30, browserArtifactsAfterDays: 7 }, defaultModelSelection: fastModel };
  const state = {
    up: options.up ?? true,
    settings: { ...defaults, ...options.settings } as Record<string, unknown>,
    projects: (options.projects ?? []).map((root, index) => ({ id: `project-${index}`, title: root, workspaceRoot: root, deletedAt: null as string | null })),
    tasks: new Map<string, StoredTask>(),
    links: options.links ?? [],
  };
  const calls: Array<{ tag: string; payload: unknown }> = [];
  const rpc: T3Rpc = {
    async call<T>(tag: string, payload: unknown) {
      calls.push({ tag, payload });
      if (tag === "server.getConfig") return { settings: structuredClone(state.settings) } as T;
      if (tag === "server.updateSettings") {
        if (!options.ignorePatch) Object.assign(state.settings, (payload as { patch: Record<string, unknown> }).patch);
        return structuredClone(state.settings) as T;
      }
      if (tag === "peerLinks.list") return { links: state.links } as T;
      if (tag === "scheduledTasks.upsert") {
        const input = payload as StoredTask;
        const task = { ...input, threadId: null, lastRunStatus: "never", runCount: 0 };
        state.tasks.set(input.id, task);
        return { task } as T;
      }
      if (tag === "scheduledTasks.setEnabled") {
        const { id, enabled } = payload as { id: string; enabled: boolean };
        state.tasks.set(id, { ...state.tasks.get(id)!, enabled });
        return { task: state.tasks.get(id) } as T;
      }
      throw new Error(`unknown RPC ${tag}`);
    },
    async first<T>(tag: string, payload: unknown) {
      calls.push({ tag, payload });
      if (tag === "scheduledTasks.subscribe") return { tasks: [...state.tasks.values()] } as T;
      throw new Error(`unknown stream ${tag}`);
    },
    async get<T>(path: string) {
      calls.push({ tag: `GET ${path}`, payload: undefined });
      if (path === "/api/orchestration/shell") return { projects: state.projects, threads: [] } as T;
      throw new Error(`unknown path ${path}`);
    },
  };
  const server: T3Server = { answering: async () => state.up, session: (_home, work) => work(rpc) };
  const tags = () => calls.map((call) => call.tag);
  return { state, calls, tags, server };
}

type Machine = { t3?: boolean; service?: "installed" | "not installed" | "unavailable"; manager?: boolean; linger?: "yes" | "no" | "" };

function runner(server: ReturnType<typeof fakeServer>, machine: Machine = {}) {
  const calls: string[] = [];
  const state = { t3: machine.t3 ?? true, service: machine.service ?? "installed" };
  const run: CommandRunner = async (command) => {
    const line = command.join(" ");
    calls.push(line);
    if (command[0] === "t3" && !state.t3) return { code: 127, stdout: "" };
    if (line === "t3 --version") return { code: 0, stdout: "0.9.0-nightly\n" };
    if (command[0] === "/bin/sh" && line.includes("t3.codes/install.sh")) return (state.t3 = true), { code: 0, stdout: "" };
    if (line === "t3 service status") {
      if (state.service === "unavailable") return { code: 0, stdout: "T3 Code service\n  Status: unavailable on this machine\n" };
      if (state.service === "not installed") return { code: 0, stdout: "T3 Code service\n  Status: not installed\n  Next: Run `t3 service install`.\n" };
      return { code: 0, stdout: "T3 Code service\n  Status: installed · t3@0.9.0\n" };
    }
    if (line === "t3 service install") return (state.service = "installed"), { code: 0, stdout: "" };
    if (line === "systemctl --user show-environment") return machine.manager === false ? { code: 1, stdout: "", stderr: "Failed to connect to bus" } : { code: 0, stdout: "HOME=/home/octo\n" };
    if (line === "loginctl show-user octo --property=Linger --value") return { code: 0, stdout: `${machine.linger ?? "yes"}\n` };
    if (command[0] === "t3" && command[1] === "project" && command[2] === "add") {
      server.state.projects.push({ id: `project-${server.state.projects.length}`, title: command[3]!, workspaceRoot: command[3]!, deletedAt: null });
      return { code: 0, stdout: `Added project at ${command[3]}.\n` };
    }
    if (command[0] === "git" && command.includes("symbolic-ref")) return { code: 0, stdout: "origin/main\n" };
    return { code: 127, stdout: "" };
  };
  return { calls, state, run };
}

function setup(options: Parameters<typeof fakeServer>[0] = {}, machine: Machine = {}) {
  const server = fakeServer(options);
  const commands = runner(server, machine);
  const adapter = t3Adapter({ run: commands.run, server: server.server, user: "octo" });
  return { server, commands, adapter };
}

describe("seedT3", () => {
  test("merges the pack keys and keeps every unknown key", async () => {
    const home = temp.make("home-");
    write(home, settingsFile, { addProjectBaseDirectory: "~/code", storageCleanup: { worktreeOnMerge: false, logsAfterDays: 14 }, keybindings: [{ key: "mod+k" }] });
    const result = await seedT3(plan("linux", base), home);
    expect(read(home, settingsFile)).toEqual({
      addProjectBaseDirectory: "~/code",
      keybindings: [{ key: "mod+k" }],
      storageCleanup: { worktreeOnMerge: false, logsAfterDays: 14 },
      defaultThreadEnvMode: "worktree",
      sidebarAutoSettleAfterDays: 3,
    });
    expect(result.findings).toContainEqual({ id: `kept:${settingsFile}`, pack: "engine", say: `Kept your storageCleanup in ${settingsFile}. Run fleet apply --adopt ${settingsFile} to take Fleet's value.` });
    expect(result.actions).toEqual([{ target: settingsFile, operation: "replace", reason: "set defaultThreadEnvMode, sidebarAutoSettleAfterDays" }]);
  });

  test("creates the file on a fresh machine, and a rerun writes nothing and does nothing", async () => {
    const home = temp.make("home-");
    const first = await seedT3(plan("linux", base), home);
    expect(first.actions.map((action) => [action.target, action.operation])).toEqual([[settingsFile, "create"]]);
    const text = readFileSync(join(home, settingsFile), "utf8");
    const saved = backups(home);
    const again = await seedT3(plan("linux", base), home);
    expect(again).toEqual({ actions: [], findings: [] });
    expect(readFileSync(join(home, settingsFile), "utf8")).toBe(text);
    expect(backups(home)).toEqual(saved);
  });

  test("keeps a key the user changed after Fleet set it", async () => {
    const home = temp.make("home-");
    await seedT3(plan("linux", base), home);
    write(home, settingsFile, { ...read(home, settingsFile), sidebarAutoSettleAfterDays: 10 });
    const result = await seedT3(plan("linux", [entry("defaultThreadEnvMode", "worktree"), entry("sidebarAutoSettleAfterDays", 5), base[2]!]), home);
    expect(read(home, settingsFile).sidebarAutoSettleAfterDays).toBe(10);
    expect(result.findings).toEqual([{ id: `kept:${settingsFile}`, pack: "engine", say: `Kept your sidebarAutoSettleAfterDays in ${settingsFile}. Run fleet apply --adopt ${settingsFile} to take Fleet's value.` }]);
    expect(result.actions).toEqual([]);
  });

  test("--adopt takes Fleet's value over the user's", async () => {
    const home = temp.make("home-");
    write(home, settingsFile, { defaultThreadEnvMode: "local" });
    await seedT3(plan("linux", base), home, { adopt: [settingsFile] });
    expect(read(home, settingsFile).defaultThreadEnvMode).toBe("worktree");
  });

  test("removes a key a pack drops, after a backup", async () => {
    const home = temp.make("home-");
    write(home, settingsFile, { theme: "dark" });
    await seedT3(plan("linux", base), home);
    const before = readFileSync(join(home, settingsFile), "utf8");
    const result = await seedT3(plan("linux", base.slice(0, 2)), home);
    expect(read(home, settingsFile)).toEqual({ theme: "dark", defaultThreadEnvMode: "worktree", sidebarAutoSettleAfterDays: 3 });
    expect(result.actions).toEqual([{ target: settingsFile, operation: "replace", reason: "remove storageCleanup" }]);
    const latest = backups(home).sort().at(-1)!;
    expect(readFileSync(join(home, ".local/state/fleet/backups", latest, settingsFile), "utf8")).toBe(before);
    expect(read(home, ".config/fleet/t3-settings.json")[settingsFile].map((field: { path: string[] }) => field.path)).toEqual([["defaultThreadEnvMode"], ["sidebarAutoSettleAfterDays"]]);
  });

  test("sets the nightly update channel in desktop-settings.json on the Mac only", async () => {
    const mac = temp.make("home-");
    write(mac, desktopFile, { mainWindowBounds: { x: 0, y: 0, width: 800, height: 600 }, updateChannel: "latest", updateChannelConfiguredByUser: false });
    await seedT3(plan("darwin", base), mac);
    expect(read(mac, desktopFile)).toEqual({ mainWindowBounds: { x: 0, y: 0, width: 800, height: 600 }, updateChannel: "nightly", updateChannelConfiguredByUser: true });
    const linux = temp.make("home-");
    await seedT3(plan("linux", base), linux);
    expect(existsSync(join(linux, desktopFile))).toBe(false);
  });

  test("keeps an update channel the user picked in T3 Code", async () => {
    const home = temp.make("home-");
    write(home, desktopFile, { updateChannel: "latest", updateChannelConfiguredByUser: true });
    const result = await seedT3(plan("darwin", []), home);
    expect(read(home, desktopFile)).toEqual({ updateChannel: "latest", updateChannelConfiguredByUser: true });
    expect(result.findings).toEqual([{ id: `kept:${desktopFile}`, pack: "engine", say: `Kept your updateChannel in ${desktopFile}. Run fleet apply --adopt ${desktopFile} to take Fleet's value.` }]);
  });

  test("writes no T3 setting through the Provider config record", async () => {
    const home = temp.make("home-");
    await seedT3(plan("linux", base), home);
    expect(existsSync(join(home, ".config/fleet/provider-fields.json"))).toBe(false);
  });
});

describe("T3 adapter with a running server", () => {
  test("patches only the changed keys through server.updateSettings, then reads them back", async () => {
    const home = temp.make("home-");
    const { server, adapter } = setup({ settings: { sidebarAutoSettleAfterDays: 3 } });
    const report = await apply(plan("linux", base), { home, adapters: [adapter] });
    const patch = server.calls.find((call) => call.tag === "server.updateSettings")?.payload;
    expect(patch).toEqual({ patch: { defaultThreadEnvMode: "worktree", storageCleanup: { worktreeOnMerge: true, logsAfterDays: 14 } } });
    expect(server.tags().filter((tag) => tag === "server.getConfig")).toHaveLength(2);
    expect(existsSync(join(home, settingsFile))).toBe(false);
    expect(report.actions).toContainEqual({ target: "t3 settings", operation: "replace", reason: "set defaultThreadEnvMode, storageCleanup" });
    const again = await apply(plan("linux", base), { home, adapters: [adapter] });
    expect(server.tags().filter((tag) => tag === "server.updateSettings")).toHaveLength(1);
    expect(again.actions).toEqual([]);
  });

  test("reports a key T3 did not take", async () => {
    const home = temp.make("home-");
    const { adapter } = setup({ ignorePatch: true });
    const report = await apply(plan("linux", base.slice(0, 1)), { home, adapters: [adapter] });
    expect(report.findings).toContainEqual({ id: "t3:settings", pack: "engine", say: "T3 Code did not take defaultThreadEnvMode. Run fleet apply again; if it stays, set it in T3 Code's settings.", repair: "apply" });
  });

  test("adds each task project once with t3 project add", async () => {
    const home = temp.make("home-");
    const { commands, adapter } = setup();
    await apply(plan("linux", [], [loop]), { home, adapters: [adapter] });
    await apply(plan("linux", [], [loop]), { home, adapters: [adapter] });
    expect(commands.calls.filter((line) => line.startsWith("t3 project add"))).toEqual([`t3 project add ${project}`]);
  });

  test("hands the Jobs adapter a task client once the server answers", async () => {
    const home = temp.make("home-");
    const { server, commands, adapter } = setup();
    const jobs = jobsAdapter({ run: commands.run, engineRoot: engine, t3: adapter.tasks });
    await apply(plan("linux", [], [loop]), { home, adapters: [adapter, jobs] });
    expect(server.state.tasks.get("fleet:quality-loop")).toMatchObject({ projectId: "project-0", enabled: true });
    await apply(plan("linux", [], [loop]), { home, adapters: [adapter, jobs] });
    expect(server.tags().filter((tag) => tag === "scheduledTasks.upsert")).toHaveLength(1);
  });

  test("gives no task client when no server answers", async () => {
    const home = temp.make("home-");
    const { adapter } = setup({ up: false });
    const report = await apply(plan("linux", base, [loop]), { home, adapters: [adapter] });
    expect(await adapter.tasks()).toBeUndefined();
    expect(read(home, settingsFile).defaultThreadEnvMode).toBe("worktree");
    expect(report.findings).toContainEqual({ id: "t3:projects", pack: "engine", say: `T3 Code is not running, so ${project} waits to be added as a project. The next fleet apply after T3 Code starts adds it.`, repair: "apply" });
  });

  test("reports expired and unreachable links without failing the apply", async () => {
    const home = temp.make("home-");
    const links: Link[] = [
      { environmentId: "env-1", label: "devbox-1", status: "reachable", lastError: null },
      { environmentId: "env-2", label: "devbox-2", status: "expired", lastError: null },
      { environmentId: "env-3", label: "devbox-3", status: "unreachable", lastError: "connect timeout" },
    ];
    const { adapter } = setup({ links });
    const report = await apply(plan("linux", []), { home, adapters: [adapter] });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([
      { id: "t3:link:env-2", pack: "engine", say: "The link to devbox-2 has expired. Link it again in T3 Code: Settings, Environments, Link environment.", repair: "human" },
      { id: "t3:link:env-3", pack: "engine", say: "T3 Code cannot reach devbox-3 (connect timeout). Check that it is on and online. If it stays unreachable, link it again in T3 Code." },
    ]);
  });
});

describe("T3 tasks client", () => {
  test("maps upsert, list, and setEnabled to the scheduled-task RPCs", async () => {
    const home = temp.make("home-");
    const server = fakeServer({ projects: [project] });
    const { run } = runner(server);
    const client = t3Tasks(server.server, home, { plan: plan("linux", [], [loop]), run });
    await client.upsert(wantedTask);
    expect(server.calls.find((call) => call.tag === "scheduledTasks.upsert")?.payload).toEqual({
      id: "fleet:quality-loop",
      title: "Fleet: quality-loop",
      prompt: "Run the quality-loop skill.",
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "02:30" },
      projectId: "project-0",
      workspaceStrategy: { type: "worktree", baseRef: "origin/main", startFromOrigin: true },
      modelSelection: fastModel,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    expect(await client.list()).toEqual([wantedTask]);
    expect(server.calls).toContainEqual({ tag: "scheduledTasks.subscribe", payload: {} });
    await client.setEnabled("fleet:quality-loop", false);
    expect(server.calls.at(-1)).toEqual({ tag: "scheduledTasks.setEnabled", payload: { id: "fleet:quality-loop", enabled: false } });
  });

  test("lists a task whose model or workspace drifted as different, so Jobs updates it", async () => {
    const home = temp.make("home-");
    const server = fakeServer({ projects: [project] });
    const { run } = runner(server);
    const client = t3Tasks(server.server, home, { plan: plan("linux", [], [loop]), run });
    await client.upsert(wantedTask);
    const stored = server.state.tasks.get("fleet:quality-loop")!;
    server.state.tasks.set(stored.id, { ...stored, modelSelection: { instanceId: "claude", model: "big" } });
    expect((await client.list())[0]).not.toEqual(wantedTask);
  });

  test("uses the model a role maps to when one is given", async () => {
    const home = temp.make("home-");
    const server = fakeServer({ projects: [project] });
    const { run } = runner(server);
    const model = { instanceId: "claude", model: "opus" };
    const client = t3Tasks(server.server, home, { plan: plan("linux", [], [loop]), run, models: (role) => (role === "implementation" ? model : undefined) });
    await client.upsert(wantedTask);
    expect(server.state.tasks.get("fleet:quality-loop")?.modelSelection).toEqual(model);
    expect(await client.list()).toEqual([wantedTask]);
  });
});

describe("T3 on Linux", () => {
  test("installs the nightly t3 and its service when both are missing", async () => {
    const home = temp.make("home-");
    const { commands, adapter } = setup({}, { t3: false, service: "not installed" });
    const report = await apply(plan("linux", []), { home, adapters: [adapter] });
    const install = commands.calls.find((line) => line.includes("t3.codes/install.sh"))!;
    expect(install).toContain("T3CODE_CHANNEL=nightly");
    expect(commands.calls).toContain("t3 service install");
    expect(report.actions).toEqual([
      { target: "t3", operation: "create", reason: "nightly channel" },
      { target: "t3 service", operation: "create" },
    ]);
    const again = await apply(plan("linux", []), { home, adapters: [adapter] });
    expect(again.actions).toEqual([]);
  });

  test("reports lingering that is off in plain words, and still installs the service", async () => {
    const home = temp.make("home-");
    const { commands, adapter } = setup({}, { service: "not installed", linger: "no" });
    const report = await apply(plan("linux", []), { home, adapters: [adapter] });
    expect(commands.calls).toContain("t3 service install");
    expect(report.ok).toBe(true);
    expect(report.findings).toContainEqual({ id: "t3:linger", pack: "engine", say: "T3 Code stops when you log out, because lingering is off for octo. Run: sudo loginctl enable-linger octo", repair: "human" });
  });

  test("reports a missing user manager and leaves the service alone", async () => {
    const home = temp.make("home-");
    const { commands, adapter } = setup({}, { service: "not installed", manager: false });
    const report = await apply(plan("linux", []), { home, adapters: [adapter] });
    expect(commands.calls).not.toContain("t3 service install");
    expect(report.findings).toContainEqual({
      id: "t3:service",
      pack: "engine",
      say: "T3 Code cannot run as a service: systemd's user manager does not answer (systemctl --user). Log in to this machine in a normal session, or install your system's systemd user-session support, then run fleet apply.",
      repair: "human",
    });
  });

  test("does not touch the service on the Mac", async () => {
    const home = temp.make("home-");
    const { commands, adapter } = setup({}, { service: "not installed" });
    await apply(plan("darwin", []), { home, adapters: [adapter] });
    expect(commands.calls.filter((line) => line.startsWith("t3 service") || line.startsWith("systemctl"))).toEqual([]);
  });
});

describe("T3 adapter guards", () => {
  test("does nothing outside the user's home when no runner is injected", async () => {
    const home = temp.make("home-");
    const server = fakeServer();
    const report = await apply(plan("linux", base, [loop]), { home, adapters: [t3Adapter({ server: server.server })] });
    expect(report.actions).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(server.calls).toEqual([]);
    expect(existsSync(join(home, ".t3"))).toBe(false);
  });

  test("doctor reports each missing piece and writes nothing", async () => {
    const home = temp.make("home-");
    const { server, commands, adapter } = setup({}, { t3: false, service: "not installed" });
    const report = await check(plan("darwin", base, [loop]), { home, adapters: [adapter], run: async () => 0 });
    const linux = await check(plan("linux", base, [loop]), { home, adapters: [adapter], run: async () => 0 });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      { id: "t3:settings", pack: "engine", say: "T3 Code needs these settings: defaultThreadEnvMode, sidebarAutoSettleAfterDays, storageCleanup.", repair: "apply" },
      { id: `t3:${desktopFile}`, pack: "engine", say: `${desktopFile} needs an update: set updateChannel, updateChannelConfiguredByUser.`, repair: "apply" },
      { id: `t3:project:${project}`, pack: "engine", say: `T3 Code needs the project ${project}.`, repair: "apply" },
    ]);
    expect(linux.findings.map((finding) => finding.id)).toEqual(["t3:cli", "t3:service", "t3:settings", `t3:project:${project}`]);
    expect(server.tags().filter((tag) => tag !== "server.getConfig" && tag !== "peerLinks.list" && !tag.startsWith("GET "))).toEqual([]);
    expect(commands.calls.filter((line) => line.includes("install") || line.includes("project add"))).toEqual([]);
    expect(existsSync(join(home, ".t3"))).toBe(false);
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  test("runs before the Jobs adapter in the engine", () => {
    expect(engineAdapters().map((adapter) => adapter.name)).toEqual(["files", "config", "t3", "jobs", "identity"]);
  });
});
