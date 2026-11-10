import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigEntry, ModelRow, Owned, PackJob, Plan, T3ProjectScript } from "../../pack/types.ts";
import { apply, check } from "../../reconciler/apply.ts";
import { tempDirs } from "../../testing/git.ts";
import { engineAdapters } from "../index.ts";
import type { FleetTask } from "../jobs/adapter.ts";
import { jobsAdapter } from "../jobs/adapter.ts";
import type { CommandRunner } from "../run.ts";
import { t3Adapter } from "./adapter.ts";
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

function plan(os: "darwin" | "linux", config: Array<Owned<ConfigEntry>>, jobs: Array<Owned<PackJob>> = [], models: ModelRow[] = []): Plan {
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
    handlers: {},
    settings: {},
    unanswered: [],
    ask: [],
    dropped: [],
    models,
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

/** As T3 Code serves settings before it folds its old fields: projectScriptOverrides is a view derived from projectSettingsOverrides. */
function withLegacyView(settings: Record<string, unknown>) {
  const copy = structuredClone(settings);
  const entries = copy.projectSettingsOverrides as Record<string, { defaultProjectScripts?: unknown }> | undefined;
  if (copy.projectSettingsFolded || !entries) return copy;
  return { ...copy, projectScriptOverrides: Object.fromEntries(Object.entries(entries).flatMap(([id, entry]) => (entry.defaultProjectScripts === undefined ? [] : [[id, entry.defaultProjectScripts]]))) };
}

function fakeServer(options: { up?: boolean; settings?: Record<string, unknown>; links?: Link[]; projects?: string[]; ignorePatch?: boolean } = {}) {
  const defaults = { defaultThreadEnvMode: "local", sidebarAutoSettleAfterDays: 7, storageCleanup: { worktreeOnMerge: false, logsAfterDays: 30, browserArtifactsAfterDays: 7 }, defaultModelSelection: fastModel };
  const state = {
    up: options.up ?? true,
    settings: { ...defaults, ...options.settings } as Record<string, unknown>,
    projects: (options.projects ?? []).map((root, index) => ({ id: `project-${index}`, title: root, workspaceRoot: root, deletedAt: null as string | null, scripts: [] as unknown[] })),
    tasks: new Map<string, StoredTask>(),
    links: options.links ?? [],
    ignorePatch: options.ignorePatch ?? false,
  };
  const calls: Array<{ tag: string; payload: unknown }> = [];
  const rpc: T3Rpc = {
    async call<T>(tag: string, payload: unknown) {
      calls.push({ tag, payload });
      if (tag === "server.getConfig") return { settings: withLegacyView(state.settings) } as T;
      if (tag === "server.updateSettings") {
        const { projectSettingsOverrides: entries, ...patch } = (payload as { patch: Record<string, unknown> }).patch;
        if (state.ignorePatch) return structuredClone(state.settings) as T;
        Object.assign(state.settings, patch);
        if (entries) {
          const merged = { ...(state.settings.projectSettingsOverrides as Record<string, object>), ...(entries as Record<string, object>) };
          state.settings.projectSettingsOverrides = Object.fromEntries(Object.entries(merged).filter(([, entry]) => Object.keys(entry).length));
        }
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

type Machine = { t3?: boolean; service?: "installed" | "not installed" | "unavailable"; manager?: boolean; linger?: "yes" | "no" | ""; originHead?: string; refs?: string[]; remotes?: string[]; gitBroken?: boolean };

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
      server.state.projects.push({ id: `project-${server.state.projects.length}`, title: command[3]!, workspaceRoot: command[3]!, deletedAt: null, scripts: [] });
      return { code: 0, stdout: `Added project at ${command[3]}.\n` };
    }
    const originHead = "originHead" in machine ? machine.originHead : "origin/main";
    if (command[0] === "git" && machine.gitBroken) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    if (command[0] === "git" && command.at(-1) === "remote") return { code: 0, stdout: (machine.remotes ?? ["origin"]).map((remote) => `${remote}\n`).join("") };
    if (command[0] === "git" && command.includes("symbolic-ref")) return originHead && command.at(-1) === `refs/remotes/${originHead.split("/")[0]}/HEAD` ? { code: 0, stdout: `${originHead}\n` } : { code: 128, stdout: "", stderr: `fatal: ref ${command.at(-1)} is not a symbolic ref` };
    if (command[0] === "git" && command.includes("rev-parse")) return (machine.refs ?? ["refs/remotes/origin/main"]).includes(command.at(-1)!.replace(/\^\{commit\}$/, "")) ? { code: 0, stdout: "abc\n" } : { code: 1, stdout: "" };
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

function seed(target: Plan, home: string, options: { adopt?: string[] } = {}) {
  const stopped = fakeServer({ up: false });
  return t3Adapter({ run: runner(stopped).run, server: stopped.server, user: "octo" }).apply(target, { home, dryRun: false, adopt: options.adopt ?? [] });
}

describe("T3 settings while T3 Code is stopped", () => {
  test("merges the pack keys and keeps every unknown key", async () => {
    const home = temp.make("home-");
    write(home, settingsFile, { addProjectBaseDirectory: "~/code", storageCleanup: { worktreeOnMerge: false, logsAfterDays: 14 }, keybindings: [{ key: "mod+k" }] });
    const result = await seed(plan("linux", base), home);
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
    const first = await seed(plan("linux", base), home);
    expect(first.actions.map((action) => [action.target, action.operation])).toEqual([[settingsFile, "create"]]);
    const text = readFileSync(join(home, settingsFile), "utf8");
    const saved = backups(home);
    const again = await seed(plan("linux", base), home);
    expect(again).toEqual({ actions: [], findings: [] });
    expect(readFileSync(join(home, settingsFile), "utf8")).toBe(text);
    expect(backups(home)).toEqual(saved);
  });

  test("keeps a key the user changed after Fleet set it", async () => {
    const home = temp.make("home-");
    await seed(plan("linux", base), home);
    write(home, settingsFile, { ...read(home, settingsFile), sidebarAutoSettleAfterDays: 10 });
    const result = await seed(plan("linux", [entry("defaultThreadEnvMode", "worktree"), entry("sidebarAutoSettleAfterDays", 5), base[2]!]), home);
    expect(read(home, settingsFile).sidebarAutoSettleAfterDays).toBe(10);
    expect(result.findings).toEqual([{ id: `kept:${settingsFile}`, pack: "engine", say: `Kept your sidebarAutoSettleAfterDays in ${settingsFile}. Run fleet apply --adopt ${settingsFile} to take Fleet's value.` }]);
    expect(result.actions).toEqual([]);
  });

  test("--adopt takes Fleet's value over the user's", async () => {
    const home = temp.make("home-");
    write(home, settingsFile, { defaultThreadEnvMode: "local" });
    await seed(plan("linux", base), home, { adopt: [settingsFile] });
    expect(read(home, settingsFile).defaultThreadEnvMode).toBe("worktree");
  });

  test("removes a key a pack drops, after a backup", async () => {
    const home = temp.make("home-");
    write(home, settingsFile, { theme: "dark" });
    await seed(plan("linux", base), home);
    const before = readFileSync(join(home, settingsFile), "utf8");
    const result = await seed(plan("linux", base.slice(0, 2)), home);
    expect(read(home, settingsFile)).toEqual({ theme: "dark", defaultThreadEnvMode: "worktree", sidebarAutoSettleAfterDays: 3 });
    expect(result.actions).toEqual([{ target: settingsFile, operation: "replace", reason: "remove storageCleanup" }]);
    const latest = backups(home).sort().at(-1)!;
    expect(readFileSync(join(home, ".local/state/fleet/backups", latest, settingsFile), "utf8")).toBe(before);
    expect(read(home, ".config/fleet/t3-settings.json")[settingsFile].map((field: { path: string[] }) => field.path)).toEqual([["defaultThreadEnvMode"], ["sidebarAutoSettleAfterDays"]]);
  });

  test("sets the nightly update channel in desktop-settings.json on the Mac only", async () => {
    const mac = temp.make("home-");
    write(mac, desktopFile, { mainWindowBounds: { x: 0, y: 0, width: 800, height: 600 }, updateChannel: "latest", updateChannelConfiguredByUser: false });
    await seed(plan("darwin", base), mac);
    expect(read(mac, desktopFile)).toEqual({ mainWindowBounds: { x: 0, y: 0, width: 800, height: 600 }, updateChannel: "nightly", updateChannelConfiguredByUser: true });
    const linux = temp.make("home-");
    await seed(plan("linux", base), linux);
    expect(existsSync(join(linux, desktopFile))).toBe(false);
  });

  test("keeps an update channel the user picked in T3 Code", async () => {
    const home = temp.make("home-");
    write(home, desktopFile, { updateChannel: "latest", updateChannelConfiguredByUser: true });
    const result = await seed(plan("darwin", []), home);
    expect(read(home, desktopFile)).toEqual({ updateChannel: "latest", updateChannelConfiguredByUser: true });
    expect(result.findings).toEqual([{ id: `kept:${desktopFile}`, pack: "engine", say: `Kept your updateChannel in ${desktopFile}. Run fleet apply --adopt ${desktopFile} to take Fleet's value.` }]);
  });

  test("keeps a channel the user picked when T3 leaves the build's default channel out", async () => {
    const home = temp.make("home-");
    write(home, desktopFile, { updateChannelConfiguredByUser: true });
    const result = await seed(plan("darwin", []), home);
    expect(read(home, desktopFile)).toEqual({ updateChannelConfiguredByUser: true });
    expect(result.actions).toEqual([]);
  });

  test("keeps T3's sparse copy of an owned setting while T3 is stopped, since a reset and a stripped default look the same", async () => {
    const home = temp.make("home-");
    const cleanup = (logsAfterDays: number) => entry("storageCleanup", { logsAfterDays, browserArtifactsAfterDays: null });
    await seed(plan("linux", [cleanup(14)]), home);
    write(home, settingsFile, { storageCleanup: { logsAfterDays: 14 } });
    const result = await seed(plan("linux", [cleanup(7)]), home);
    expect(read(home, settingsFile).storageCleanup).toEqual({ logsAfterDays: 14 });
    expect(result.findings).toEqual([{ id: `kept:${settingsFile}`, pack: "engine", say: `Kept your storageCleanup in ${settingsFile}. Run fleet apply --adopt ${settingsFile} to take Fleet's value.` }]);
  });

  test("adds a nested setting that the file lacks while T3 is stopped", async () => {
    const home = temp.make("home-");
    await seed(plan("linux", [entry("storageCleanup", { logsAfterDays: 14 })]), home);
    const result = await seed(plan("linux", [entry("storageCleanup", { logsAfterDays: 14, worktreeOnMerge: true })]), home);
    expect(read(home, settingsFile).storageCleanup).toEqual({ logsAfterDays: 14, worktreeOnMerge: true });
    expect(result.actions).toEqual([{ target: settingsFile, operation: "replace", reason: "set storageCleanup" }]);
  });

  test("writes no T3 setting through the Provider config record", async () => {
    const home = temp.make("home-");
    await seed(plan("linux", base), home);
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
    expect(server.tags().slice(0, 3)).toEqual(["server.getConfig", "server.updateSettings", "server.getConfig"]);
    expect(existsSync(join(home, settingsFile))).toBe(false);
    expect(report.actions).toContainEqual({ target: "t3 settings", operation: "replace", reason: "set defaultThreadEnvMode, storageCleanup" });
    const again = await apply(plan("linux", base), { home, adapters: [adapter] });
    expect(server.tags().filter((tag) => tag === "server.updateSettings")).toHaveLength(1);
    expect(again.actions).toEqual([]);
  });

  test("retries a value T3 did not take on the next apply", async () => {
    const home = temp.make("home-");
    await seed(plan("linux", [entry("sidebarAutoSettleAfterDays", 3)]), home);
    const { server, adapter } = setup({ settings: { sidebarAutoSettleAfterDays: 3 }, ignorePatch: true });
    const refused = await apply(plan("linux", [entry("sidebarAutoSettleAfterDays", 5)]), { home, adapters: [adapter] });
    expect(refused.findings.map((finding) => finding.id)).toContain("t3:settings");
    server.state.ignorePatch = false;
    const retried = await apply(plan("linux", [entry("sidebarAutoSettleAfterDays", 5)]), { home, adapters: [adapter] });
    expect(server.calls.filter((call) => call.tag === "server.updateSettings")).toHaveLength(2);
    expect(server.state.settings.sidebarAutoSettleAfterDays).toBe(5);
    expect(retried.findings).toEqual([]);
  });

  test("retries a refused first adoption on the next plain apply", async () => {
    const home = temp.make("home-");
    write(home, settingsFile, { sidebarAutoSettleAfterDays: 3 });
    const { server, adapter } = setup({ settings: { sidebarAutoSettleAfterDays: 3 }, ignorePatch: true });
    const wanted = plan("linux", [entry("sidebarAutoSettleAfterDays", 5)]);
    const refused = await apply(wanted, { home, adapters: [adapter], adopt: [settingsFile] });
    expect(refused.findings.map((finding) => finding.id)).toContain("t3:settings");
    server.state.ignorePatch = false;
    const retried = await apply(wanted, { home, adapters: [adapter] });
    expect(server.state.settings.sidebarAutoSettleAfterDays).toBe(5);
    expect(retried.findings).toEqual([]);
  });

  test("keeps a nested setting the user reset to T3's default, though T3 left it out of the file", async () => {
    const home = temp.make("home-");
    await seed(plan("linux", [entry("storageCleanup", { logsAfterDays: 14, worktreeOnMerge: true })]), home);
    write(home, settingsFile, { storageCleanup: { logsAfterDays: 14 } });
    const { server, adapter } = setup({ settings: { storageCleanup: { worktreeOnMerge: false, logsAfterDays: 14, browserArtifactsAfterDays: 7 } } });
    const report = await apply(plan("linux", [entry("storageCleanup", { logsAfterDays: 7, worktreeOnMerge: true })]), { home, adapters: [adapter] });
    expect(server.tags()).not.toContain("server.updateSettings");
    expect(report.findings).toContainEqual({ id: `kept:${settingsFile}`, pack: "engine", say: `Kept your storageCleanup in ${settingsFile}. Run fleet apply --adopt ${settingsFile} to take Fleet's value.` });
  });

  test("treats a default T3 left out of the file as unchanged, and updates the setting", async () => {
    const home = temp.make("home-");
    await seed(plan("linux", [entry("storageCleanup", { logsAfterDays: 14, worktreeOnMerge: false })]), home);
    write(home, settingsFile, { storageCleanup: { logsAfterDays: 14 } });
    const { server, adapter } = setup({ settings: { storageCleanup: { worktreeOnMerge: false, logsAfterDays: 14, browserArtifactsAfterDays: 7 } } });
    const wanted = plan("linux", [entry("storageCleanup", { logsAfterDays: 7, worktreeOnMerge: false })]);
    const report = await apply(wanted, { home, adapters: [adapter] });
    expect(report.findings).toEqual([]);
    expect(server.state.settings.storageCleanup).toEqual({ logsAfterDays: 7, worktreeOnMerge: false });
    const again = await apply(wanted, { home, adapters: [adapter] });
    expect(again).toMatchObject({ actions: [], findings: [] });
    expect(server.tags().filter((tag) => tag === "server.updateSettings")).toHaveLength(1);
  });

  test("patches a nested setting T3 does not hold yet", async () => {
    const home = temp.make("home-");
    await seed(plan("linux", [entry("storageCleanup", { logsAfterDays: 14 })]), home);
    write(home, settingsFile, { storageCleanup: { logsAfterDays: 14 } });
    const { server, adapter } = setup({ settings: { storageCleanup: { worktreeOnMerge: false, logsAfterDays: 14, browserArtifactsAfterDays: 7 } } });
    await apply(plan("linux", [entry("storageCleanup", { logsAfterDays: 14, worktreeOnMerge: true })]), { home, adapters: [adapter] });
    expect(server.calls.find((call) => call.tag === "server.updateSettings")?.payload).toEqual({ patch: { storageCleanup: { logsAfterDays: 14, worktreeOnMerge: true } } });
  });

  test("reports a key T3 did not take", async () => {
    const home = temp.make("home-");
    const { adapter } = setup({ ignorePatch: true });
    const report = await apply(plan("linux", base.slice(0, 1)), { home, adapters: [adapter] });
    expect(report.findings).toContainEqual({ id: "t3:settings", pack: "engine", say: "T3 Code did not take defaultThreadEnvMode. Run fleet apply again; if it stays, set it in T3 Code's settings.", repair: "apply" });
  });

  test("adds a ~/ project once, under the user's home", async () => {
    const home = temp.make("home-");
    const { commands, adapter } = setup();
    const job = { ...loop, task: { ...loop.task!, project: "~/code" } };
    await apply(plan("linux", [], [job]), { home, adapters: [adapter] });
    const again = await apply(plan("linux", [], [job]), { home, adapters: [adapter] });
    expect(commands.calls.filter((line) => line.startsWith("t3 project add"))).toEqual([`t3 project add ${home}/code`]);
    expect(again.actions).toEqual([]);
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

describe("T3 project scripts", () => {
  const prepare: Owned<T3ProjectScript> = { id: "prepare", name: "Prepare worktree", command: "fleet prepare --fast", projects: ["/work/app"], pack: "team" };
  const lint = { id: "lint", name: "Lint", command: "pnpm lint", icon: "lint", runOnWorktreeCreate: false };
  const userSetup = { id: "setup", name: "Setup", command: "pnpm install", icon: "configure", runOnWorktreeCreate: true };
  const ours = { id: "fleet-team-prepare", name: "Prepare worktree", icon: "configure", command: "/bin/sh '/opt/fleet-engine/fleet' prepare --fast", runOnWorktreeCreate: true, async: false };
  const withScripts = (scripts: Array<Owned<T3ProjectScript>>, base = plan("linux", [])): Plan => ({ ...base, engineRoot: engine, t3ProjectScripts: scripts });
  const updates = (server: ReturnType<typeof fakeServer>) => server.tags().filter((tag) => tag === "server.updateSettings").length;

  test("puts a pack's script first on each matching project only, and removing the pack restores what the project inherited", async () => {
    const home = temp.make("home-");
    const { server, adapter } = setup({ projects: ["/work/app", "/work/other"], settings: { projectSettingsFolded: true, defaultProjectScripts: [lint], projectSettingsOverrides: { "project-0": { defaultAutoPull: true } } } });

    const added = await apply(withScripts([prepare]), { home, adapters: [adapter] });
    expect(server.state.settings.projectSettingsOverrides).toEqual({ "project-0": { defaultAutoPull: true, defaultProjectScripts: [ours, lint] } });
    expect(added.actions).toContainEqual({ target: "t3 project /work/app", operation: "replace", reason: "add script fleet-team-prepare" });

    await apply(withScripts([prepare]), { home, adapters: [adapter] });
    expect(updates(server)).toBe(1);

    const removed = await apply(withScripts([]), { home, adapters: [adapter] });
    expect(server.state.settings.projectSettingsOverrides).toEqual({ "project-0": { defaultAutoPull: true } });
    expect(removed.actions).toContainEqual({ target: "t3 project /work/app", operation: "replace", reason: "remove script fleet-team-prepare" });
  });

  test("chains the project's own worktree script after Fleet's, because T3 Code runs only the first, and leaves it in place", async () => {
    const home = temp.make("home-");
    const { server, adapter } = setup({ projects: ["/work/app"], settings: { projectSettingsOverrides: {} } });
    server.state.projects[0]!.scripts = [userSetup, lint];

    await apply(withScripts([prepare]), { home, adapters: [adapter] });
    expect(server.state.settings.projectSettingsOverrides).toEqual({ "project-0": { defaultProjectScripts: [{ ...ours, command: `(\n${ours.command}\n) && (\npnpm install\n)` }, userSetup, lint] } });

    await apply(withScripts([]), { home, adapters: [adapter] });
    expect(server.state.settings.projectSettingsOverrides).toEqual({});
  });

  test("chains commands that end in ; or & into a script the shell can run", async () => {
    const home = temp.make("home-");
    const { server, adapter } = setup({ projects: ["/work/app"], settings: { projectSettingsOverrides: {} } });
    server.state.projects[0]!.scripts = [{ ...userSetup, command: "pnpm install &" }];
    await apply(withScripts([{ ...prepare, command: "printf ready;" }, { ...prepare, id: "warm", command: "printf warm" }]), { home, adapters: [adapter] });
    const first = (server.state.settings.projectSettingsOverrides as Record<string, { defaultProjectScripts: Array<{ command: string }> }>)["project-0"]!.defaultProjectScripts[0]!;
    expect(first.command).toBe("(\nprintf ready;\n) && (\nprintf warm\n) && (\npnpm install &\n)");
    expect(Bun.spawnSync(["sh", "-n", "-c", first.command]).exitCode).toBe(0);
  });

  test("matches ~/ and * patterns under the user's home, and skips a deleted project", async () => {
    const home = temp.make("home-");
    const { server, adapter } = setup({ projects: [join(home, "dev/posthog"), join(home, "posthog-old"), join(home, "src/posthog")], settings: { projectSettingsOverrides: {} } });
    server.state.projects[2]!.deletedAt = "2026-11-01T00:00:00.000Z";
    await apply(withScripts([{ ...prepare, projects: ["~/*/posthog"] }]), { home, adapters: [adapter] });
    expect(Object.keys(server.state.settings.projectSettingsOverrides as object)).toEqual(["project-0"]);
  });

  test("keeps Fleet's script while a pack source cannot be fetched", async () => {
    const home = temp.make("home-");
    const { server, adapter } = setup({ projects: ["/work/app"], settings: { projectSettingsOverrides: {} } });
    await apply(withScripts([prepare]), { home, adapters: [adapter] });
    const outage = withScripts([]);
    outage.packs = [{ name: "team", source: "team", ref: "main", available: false, reason: "not found; unreachable source team" }];
    await apply(outage, { home, adapters: [adapter] });
    expect(updates(server)).toBe(1);
  });

  test("leaves a project as it is while one of two packs that put scripts on it cannot be fetched", async () => {
    const home = temp.make("home-");
    const { server, adapter } = setup({ projects: ["/work/app"], settings: { projectSettingsOverrides: {} } });
    const other = { ...prepare, pack: "other" };
    await apply(withScripts([prepare, other]), { home, adapters: [adapter] });
    const before = structuredClone(server.state.settings.projectSettingsOverrides);
    const outage = withScripts([prepare]);
    outage.packs = [{ name: "other", source: "other", ref: "main", available: false, reason: "not found; unreachable source other" }];
    await apply(outage, { home, adapters: [adapter] });
    expect(server.state.settings.projectSettingsOverrides).toEqual(before);
    expect(updates(server)).toBe(1);
  });

  test("skips a project setting that holds no usable path, and says how to fix it, without stopping the apply", async () => {
    const home = temp.make("home-");
    const { server, adapter } = setup({ projects: ["/work/app"], settings: { projectSettingsOverrides: {} } });
    const broken = withScripts([{ ...prepare, projectSetting: "team.checkout" }]);
    broken.settings = { "team.checkout": "app" };
    const report = await apply(broken, { home, adapters: [adapter] });
    expect(report.findings).toContainEqual({ id: "t3:script-setting:fleet-team-prepare", pack: "engine", say: 'The setting team.checkout is "app", not an absolute path or a path under ~/, so the worktree script fleet-team-prepare skips it. Fix it with fleet set team.checkout=<path>.', repair: "human" });
    expect(Object.keys(server.state.settings.projectSettingsOverrides as object)).toEqual(["project-0"]);
  });

  test("adds each existing folder a script names by plain path as a T3 project, so one apply puts the script on it", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, "app"), { recursive: true });
    const named = { ...prepare, projects: ["~/app", "~/missing", "~/work/*"] };
    const { server, commands, adapter } = setup({ settings: { projectSettingsFolded: true, projectSettingsOverrides: {} } });
    const report = await apply(withScripts([named]), { home, adapters: [adapter] });
    expect(commands.calls.filter((line) => line.startsWith("t3 project add"))).toEqual([`t3 project add ${home}/app`]);
    expect(report.actions).toContainEqual({ target: "t3 project ~/app", operation: "create" });
    expect(server.state.settings.projectSettingsOverrides).toEqual({ "project-0": { defaultProjectScripts: [ours] } });
    await apply(withScripts([named]), { home, adapters: [adapter] });
    expect(commands.calls.filter((line) => line.startsWith("t3 project add")).length).toBe(1);
  });

  test("waits while T3 Code is not running, and doctor names the missing script without writing", async () => {
    const home = temp.make("home-");
    const stopped = await apply(withScripts([prepare]), { home, adapters: [setup({ up: false }).adapter] });
    expect(stopped.findings).toContainEqual({ id: "t3:scripts", pack: "engine", say: "T3 Code is not running, so the worktree script fleet-team-prepare waits. The next fleet apply after T3 Code starts adds it.", repair: "apply" });

    const { server, adapter } = setup({ projects: ["/work/app"], settings: { projectSettingsOverrides: {} } });
    const report = await check(withScripts([prepare]), { home, adapters: [adapter], run: async () => 0 });
    expect(report.findings).toContainEqual({ id: "t3:script:/work/app", pack: "engine", say: "T3 Code needs the worktree script fleet-team-prepare on /work/app.", repair: "apply" });
    expect(updates(server)).toBe(0);
  });

  test("asks for a newer T3 Code when the server keeps no project settings, and reports a script T3 did not take", async () => {
    const home = temp.make("home-");
    const old = await apply(withScripts([prepare]), { home, adapters: [setup({ projects: ["/work/app"] }).adapter] });
    expect(old.findings).toContainEqual({ id: "t3:scripts", pack: "engine", say: "This T3 Code keeps no project settings, so Fleet cannot add the worktree script fleet-team-prepare. Update T3 Code, then run fleet apply.", repair: "human" });

    const refused = await apply(withScripts([prepare]), { home, adapters: [setup({ projects: ["/work/app"], settings: { projectSettingsOverrides: {} }, ignorePatch: true }).adapter] });
    expect(refused.findings).toContainEqual({ id: "t3:script:/work/app", pack: "engine", say: "T3 Code did not take the worktree scripts for /work/app. Run fleet apply again.", repair: "apply" });
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

  test("lists a task whose worktree base drifted as different", async () => {
    const home = temp.make("home-");
    const server = fakeServer({ projects: [project] });
    const { run } = runner(server);
    const client = t3Tasks(server.server, home, { plan: plan("linux", [], [loop]), run });
    await client.upsert(wantedTask);
    const stored = server.state.tasks.get("fleet:quality-loop")!;
    expect(stored.workspaceStrategy).toEqual({ type: "worktree", baseRef: "origin/main", startFromOrigin: true });
    server.state.tasks.set(stored.id, { ...stored, workspaceStrategy: { type: "worktree", baseRef: "feature/old", startFromOrigin: false } });
    expect((await client.list())[0]).not.toEqual(wantedTask);
  });

  test("finds a project given as ~/ under the user's home", async () => {
    const home = temp.make("home-");
    const server = fakeServer({ projects: [join(home, "code")] });
    const { run } = runner(server);
    const job = { ...loop, task: { ...loop.task!, project: "~/code" } };
    const client = t3Tasks(server.server, home, { plan: plan("linux", [], [job]), run });
    await client.upsert({ ...wantedTask, project: "~/code" });
    expect(await client.list()).toEqual([{ ...wantedTask, project: "~/code" }]);
  });

  test("bases a worktree on the remote branch that exists when origin/HEAD is missing", async () => {
    const home = temp.make("home-");
    const server = fakeServer({ projects: [project] });
    const { run } = runner(server, { originHead: undefined, refs: ["refs/remotes/origin/master"] });
    const client = t3Tasks(server.server, home, { plan: plan("linux", [], [loop]), run });
    await client.upsert(wantedTask);
    expect(server.state.tasks.get("fleet:quality-loop")?.workspaceStrategy).toEqual({ type: "worktree", baseRef: "origin/master", startFromOrigin: true });
  });

  test("bases a worktree on the primary remote's default branch when there is no origin", async () => {
    const home = temp.make("home-");
    const server = fakeServer({ projects: [project] });
    const { run } = runner(server, { remotes: ["mirror", "backup"], originHead: "mirror/develop", refs: ["refs/remotes/mirror/develop", "refs/heads/main"] });
    const client = t3Tasks(server.server, home, { plan: plan("linux", [], [loop]), run });
    await client.upsert(wantedTask);
    expect(server.state.tasks.get("fleet:quality-loop")?.workspaceStrategy).toEqual({ type: "worktree", baseRef: "mirror/develop", startFromOrigin: true });
    expect(await client.list()).toEqual([wantedTask]);
  });

  test("lists an unchanged task as unchanged when git cannot read its project", async () => {
    const home = temp.make("home-");
    const server = fakeServer({ projects: [project] });
    const machine: Machine = {};
    const { run } = runner(server, machine);
    const client = t3Tasks(server.server, home, { plan: plan("linux", [], [loop]), run });
    await client.upsert(wantedTask);
    machine.gitBroken = true;
    expect(await client.list()).toEqual([wantedTask]);
  });

  test("refuses a task whose project has no main or master branch", async () => {
    const home = temp.make("home-");
    const server = fakeServer({ projects: [project] });
    const { run } = runner(server, { originHead: undefined, refs: [] });
    const client = t3Tasks(server.server, home, { plan: plan("linux", [], [loop]), run });
    expect(client.upsert(wantedTask)).rejects.toThrow(`${project} has no main or master branch to start worktrees from`);
    expect(server.state.tasks.size).toBe(0);
  });

  test.each([
    ["claude", { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] }],
    ["codex", { instanceId: "codex", model: "claude-opus-5-5", options: [{ id: "reasoningEffort", value: "high" }] }],
  ] as const)("runs a task on the %s model and effort the plan's model table gives its role", async (provider, selection) => {
    const home = temp.make("home-");
    const server = fakeServer({ projects: [project] });
    const { run } = runner(server);
    const models: ModelRow[] = [
      { role: "review", work: "Review", provider: "codex", model: "other", effort: "low" },
      { role: "implementation", work: "Implementation", provider, model: "claude-opus-5-5", effort: "high" },
    ];
    const client = t3Tasks(server.server, home, { plan: plan("linux", [], [loop], models), run });
    await client.upsert(wantedTask);
    expect(server.state.tasks.get("fleet:quality-loop")?.modelSelection).toEqual(selection);
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

  test("writes Fleet's settings before it installs t3 or its service, so T3 Code's first start reads them", async () => {
    const home = temp.make("home-");
    const { server, commands } = setup({ up: false }, { t3: false, service: "not installed" });
    const seen: Array<{ line: string; settings: unknown }> = [];
    const run: CommandRunner = async (command) => {
      seen.push({ line: command.join(" "), settings: existsSync(join(home, settingsFile)) ? read(home, settingsFile) : undefined });
      return commands.run(command);
    };
    const watched = t3Adapter({ run, server: server.server, user: "octo" });
    const report = await apply(plan("linux", base), { home, adapters: [watched] });
    const starts = seen.filter(({ line }) => line.includes("t3.codes/install.sh") || line === "t3 service install");
    expect(starts).toHaveLength(2);
    for (const start of starts) expect(start.settings).toEqual({ defaultThreadEnvMode: "worktree", sidebarAutoSettleAfterDays: 3, storageCleanup: { worktreeOnMerge: true, logsAfterDays: 14 } });
    expect(report.actions.map((action) => action.target)).toEqual([settingsFile, "t3", "t3 service"]);
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
