import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { loadPacks, PackError } from "./manifest.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function sourceWith(packs: Record<string, unknown>) {
  const dir = temp.make();
  for (const [name, manifest] of Object.entries(packs)) {
    mkdirSync(join(dir, "packs", name), { recursive: true });
    writeFileSync(join(dir, "packs", name, "pack.json"), JSON.stringify(manifest));
  }
  return dir;
}

const base = {
  schema: 1,
  name: "base",
  summary: "Safety rules every agent follows.",
  settings: [{ key: "base.heavySlots", question: "How many heavy commands may run at once?", type: "number", default: 2 }],
  workflows: [{ id: "heavy", name: "Heavy slot", sentence: "Builds run in a capped slot.", default: true, needs: ["devbox"] }],
  jobs: [{ id: "prune", command: ["fleet", "prune"], schedule: { every: "1d" }, workflow: "heavy" }],
};

describe("loadPacks", () => {
  test("loads every pack of a source", async () => {
    const packs = await loadPacks(sourceWith({ base }));
    expect(packs.map((pack) => pack.manifest.name)).toEqual(["base"]);
    expect(packs[0]?.manifest.workflows?.[0]?.needs).toEqual(["devbox"]);
  });

  test("rejects a schema it does not know", async () => {
    const dir = sourceWith({ base: { ...base, schema: 2 } });
    expect(loadPacks(dir)).rejects.toThrow(new PackError(`${join(dir, "packs/base/pack.json")}: unknown schema 2`));
  });

  test("accepts a title and rejects an empty one", async () => {
    const [pack] = await loadPacks(sourceWith({ base: { ...base, title: "Base rules" } }));
    expect(pack!.manifest.title).toBe("Base rules");
    expect(loadPacks(sourceWith({ base: { ...base, title: "" } }))).rejects.toThrow("title must be the name people read");
  });

  test("rejects a manifest whose name is not its directory", async () => {
    expect(loadPacks(sourceWith({ other: base }))).rejects.toThrow("name base does not match its directory other");
  });

  test("rejects a setting outside the pack's namespace", async () => {
    const settings = [{ ...base.settings[0], key: "hub.heavySlots" }];
    expect(loadPacks(sourceWith({ base: { ...base, settings } }))).rejects.toThrow("setting hub.heavySlots must start with base.");
  });

  test("lets any pack declare identity.signer, which the engine reads", async () => {
    const signer = { key: "identity.signer", question: "Which key signs?", type: "choice", choices: [{ value: "ssh", label: "SSH" }], default: "ssh" };
    const packs = await loadPacks(sourceWith({ base, team: { schema: 1, name: "team", summary: "Team rules.", settings: [signer] } }));
    expect(packs.map((pack) => pack.manifest.settings?.[0]?.key)).toEqual(["base.heavySlots", "identity.signer"]);
  });

  test("rejects a time-zone default that does not fit the setting", async () => {
    const settings = [{ ...base.settings[0], ask: "setup", defaultByTimeZone: { "Europe/": "two" } }];
    expect(loadPacks(sourceWith({ base: { ...base, settings } }))).rejects.toThrow("settings base.heavySlots: defaultByTimeZone must map time-zone prefixes to values that fit type number");
    const unasked = [{ ...base.settings[0], defaultByTimeZone: { "Europe/": 3 } }];
    expect(loadPacks(sourceWith({ base: { ...base, settings: unasked } }))).rejects.toThrow("settings base.heavySlots: defaultByTimeZone needs ask setup, because only setup reads it");
    const sound = [{ ...base.settings[0], ask: "setup", defaultByTimeZone: { "Europe/": 3 } }];
    expect((await loadPacks(sourceWith({ base: { ...base, settings: sound } })))[0]?.manifest.settings?.[0]?.defaultByTimeZone).toEqual({ "Europe/": 3 });
  });

  test("rejects a workflow need outside the closed set", async () => {
    const workflows = [{ ...base.workflows[0], needs: ["laptop"] }];
    expect(loadPacks(sourceWith({ base: { ...base, workflows } }))).rejects.toThrow("workflow heavy has unknown need laptop");
  });

  test("rejects a yield to a workflow the pack does not declare, to itself, in a cycle, or to a workflow that requires it", async () => {
    const flow = (id: string, fields: { requires?: string[]; yields?: string[] } = {}) => ({ id, name: id, sentence: `${id}.`, default: true, ...fields });
    const load = (...workflows: unknown[]) => loadPacks(sourceWith({ base: { ...base, workflows: [...base.workflows, ...workflows] } }));
    expect(load(flow("direct", { yields: ["missing"] }))).rejects.toThrow("workflow direct yields to unknown workflow missing");
    expect(load(flow("direct", { yields: ["direct"] }))).rejects.toThrow("workflow direct yields to itself");
    expect(load(flow("a", { yields: ["b"] }), flow("b", { yields: ["c"] }), flow("c", { yields: ["a"] }))).rejects.toThrow("workflows yield in a cycle: a, b, c, a");
    expect(load(flow("direct", { yields: ["routed"] }), flow("routed", { requires: ["step"] }), flow("step", { requires: ["direct"] }))).rejects.toThrow("workflow direct yields to routed, which needs direct");
    expect((await load(flow("a", { yields: ["b"] }), flow("b", { yields: ["c"] }), flow("c", { requires: ["heavy"] })))[0]?.manifest.workflows?.map((workflow) => workflow.id)).toEqual(["heavy", "a", "b", "c"]);
  });

  test("rejects an item tied to a workflow the pack does not declare", async () => {
    const jobs = [{ ...base.jobs[0], workflow: "missing" }];
    expect(loadPacks(sourceWith({ base: { ...base, jobs } }))).rejects.toThrow("jobs prune names unknown workflow missing");
  });

  test("rejects a T3 job without a task", async () => {
    const jobs = [{ ...base.jobs[0], runner: "t3" }];
    expect(loadPacks(sourceWith({ base: { ...base, jobs } }))).rejects.toThrow("job prune runs on t3 but has no task");
  });

  test("rejects a step that waits for a human step the pack does not declare", async () => {
    const human = [{ id: "coder", say: "Sign in to Coder", probe: ["coder", "whoami"] }];
    expect(loadPacks(sourceWith({ base: { ...base, human, steps: [{ id: "start", run: ["start"], after: "coder" }] } }))).resolves.toHaveLength(1);
    expect(loadPacks(sourceWith({ base: { ...base, human, steps: [{ id: "start", run: ["start"], after: "github" }] } }))).rejects.toThrow("steps start: after must name a human step of this pack");
  });

  test("accepts T3 project scripts with a name, a command, and project paths", async () => {
    const script = { id: "prepare", name: "Prepare worktree", command: "fleet prepare", projects: ["~/posthog", "~/*/posthog"] };
    expect(loadPacks(sourceWith({ base: { ...base, t3ProjectScripts: [script] } }))).resolves.toHaveLength(1);
    expect(loadPacks(sourceWith({ base: { ...base, t3ProjectScripts: [{ ...script, command: undefined }] } }))).rejects.toThrow("t3ProjectScripts prepare: needs an id, a name, a command, and projects or a projectSetting");
    expect(loadPacks(sourceWith({ base: { ...base, t3ProjectScripts: [{ ...script, projects: ["posthog"] }] } }))).rejects.toThrow("t3ProjectScripts prepare: each project must be an absolute path or start with ~/");
    expect(loadPacks(sourceWith({ base: { ...base, t3ProjectScripts: [{ ...script, id: "Prepare It" }] } }))).rejects.toThrow("t3ProjectScripts Prepare It: id must be lowercase words joined by dashes");
    await expect(loadPacks(sourceWith({ base: { ...base, t3ProjectScripts: [{ ...script, name: "" }] } }))).rejects.toThrow("t3ProjectScripts prepare: needs an id, a name, a command, and projects or a projectSetting");
    await expect(loadPacks(sourceWith({ base: { ...base, t3ProjectScripts: [{ ...script, command: "   " }] } }))).rejects.toThrow("t3ProjectScripts prepare: needs an id, a name, a command, and projects or a projectSetting");
  });

  test("accepts a T3 project script whose project comes from a setting", async () => {
    const script = { id: "prepare", name: "Prepare worktree", command: "fleet prepare", projects: [], projectSetting: "team.checkout" };
    await expect(loadPacks(sourceWith({ base: { ...base, t3ProjectScripts: [script] } }))).resolves.toHaveLength(1);
    await expect(loadPacks(sourceWith({ base: { ...base, t3ProjectScripts: [{ ...script, projectSetting: undefined }] } }))).rejects.toThrow("t3ProjectScripts prepare: needs an id, a name, a command, and projects or a projectSetting");
    await expect(loadPacks(sourceWith({ base: { ...base, t3ProjectScripts: [{ ...script, projectSetting: " " }] } }))).rejects.toThrow("t3ProjectScripts prepare: projectSetting must name a setting");
  });

  test("leaves T3's project settings to t3ProjectScripts", async () => {
    for (const key of ["projectSettingsOverrides", "projectScriptOverrides"]) {
      await expect(loadPacks(sourceWith({ base: { ...base, config: [{ provider: "t3", key, value: {} }] } }))).rejects.toThrow(`config ${key}: T3 project settings hold Fleet's worktree scripts, so set those with t3ProjectScripts`);
    }
  });

  test("accepts a Claude MCP server only by name, with a server object", async () => {
    const server = { provider: "claude", key: "mcpServers.metabase", value: { type: "stdio", command: "fleet" } };
    expect(loadPacks(sourceWith({ base: { ...base, config: [server] } }))).resolves.toHaveLength(1);
    expect(loadPacks(sourceWith({ base: { ...base, config: [{ ...server, key: "mcpServers", value: { metabase: server.value } }] } }))).rejects.toThrow("config mcpServers: a Claude MCP server key names one server, such as mcpServers.<name>");
    expect(loadPacks(sourceWith({ base: { ...base, config: [{ ...server, value: "fleet" }] } }))).rejects.toThrow("config mcpServers.metabase: a Claude MCP server must be an object, such as { \"type\": \"stdio\", \"command\": ... }");
  });

  test("accepts an interactive human step only with a command", async () => {
    const coder = { id: "coder", say: "Sign in to Coder", probe: ["coder", "whoami"] };
    expect(loadPacks(sourceWith({ base: { ...base, human: [{ ...coder, command: "coder login", interactive: true }] } }))).resolves.toHaveLength(1);
    expect(loadPacks(sourceWith({ base: { ...base, human: [{ ...coder, interactive: true }] } }))).rejects.toThrow("human coder: interactive needs a command to run");
    expect(loadPacks(sourceWith({ base: { ...base, human: [{ ...coder, command: "coder login", interactive: "yes" }] } }))).rejects.toThrow("human coder: interactive must be true when set");
  });

  test("accepts a profile org only as a GitHub owner name", async () => {
    await expect(loadPacks(sourceWith({ base: { ...base, profileOrg: "acme-team" } }))).resolves.toHaveLength(1);
    await expect(loadPacks(sourceWith({ base: { ...base, profileOrg: "acme/team" } }))).rejects.toThrow("profileOrg must be a GitHub org name");
    await expect(loadPacks(sourceWith({ base: { ...base, profileOrg: "" } }))).rejects.toThrow("profileOrg must be a GitHub org name");
  });

  test("accepts a handler only for a seam the engine knows, with a path", async () => {
    const handler = { seam: "review-bot", path: "lib/review-bot.ts" };
    await expect(loadPacks(sourceWith({ base: { ...base, handlers: [handler] } }))).resolves.toHaveLength(1);
    await expect(loadPacks(sourceWith({ base: { ...base, handlers: [{ ...handler, seam: "deploy-bot" }] } }))).rejects.toThrow("handlers deploy-bot: seam must be one of review-bot, heavy-route, pr-command");
    await expect(loadPacks(sourceWith({ base: { ...base, handlers: [{ ...handler, path: "" }] } }))).rejects.toThrow("handlers review-bot: needs a path");
    await expect(loadPacks(sourceWith({ base: { ...base, handlers: [{ ...handler, workflow: "nope" }] } }))).rejects.toThrow("handlers review-bot names unknown workflow nope");
    await expect(loadPacks(sourceWith({ base: { ...base, handlers: [handler, handler] } }))).rejects.toThrow("handlers review-bot is declared twice");
  });

  test("takes the fleet pr words a pr-command handler runs, and subcommands on no other seam", async () => {
    const pr = { seam: "pr-command", path: "lib/pr.ts" };
    await expect(loadPacks(sourceWith({ base: { ...base, handlers: [{ ...pr, subcommands: ["queue-wait", "ownerless"] }] } }))).resolves.toHaveLength(1);
    await expect(loadPacks(sourceWith({ base: { ...base, handlers: [pr] } }))).rejects.toThrow("handlers pr-command: needs subcommands, the fleet pr words it runs");
    await expect(loadPacks(sourceWith({ base: { ...base, handlers: [{ ...pr, subcommands: [] }] } }))).rejects.toThrow("handlers pr-command: needs subcommands, the fleet pr words it runs");
    await expect(loadPacks(sourceWith({ base: { ...base, handlers: [{ ...pr, subcommands: ["Queue wait"] }] } }))).rejects.toThrow("handlers pr-command: each subcommand must be lowercase words joined by dashes");
    await expect(loadPacks(sourceWith({ base: { ...base, handlers: [{ seam: "review-bot", path: "lib/bot.ts", subcommands: ["x"] }] } }))).rejects.toThrow("handlers review-bot: only a pr-command handler takes subcommands");
  });

  test("accepts a job that runs always only without a time, a T3 runner, or a task", async () => {
    const service = { id: "listen", command: ["fleet", "listen"], schedule: { every: "always" as const } };
    const task = { prompt: "Listen.", projectSetting: "base.project", modelRole: "worker", workspaceStrategy: "worktree", runtimeMode: "auto" };
    expect((await loadPacks(sourceWith({ base: { ...base, jobs: [service] } })))[0]?.manifest.jobs?.[0]).toEqual(service);
    expect(loadPacks(sourceWith({ base: { ...base, jobs: [{ ...service, schedule: { every: "always", at: "03:00" } }] } }))).rejects.toThrow("jobs listen: a job that runs always has no schedule.at");
    expect(loadPacks(sourceWith({ base: { ...base, jobs: [{ ...service, runner: "t3", task }] } }))).rejects.toThrow("jobs listen: a job that runs always runs on the machine, not on t3");
    expect(loadPacks(sourceWith({ base: { ...base, jobs: [{ ...service, schedule: { every: "forever" } }] } }))).rejects.toThrow("jobs listen: schedule.every must be 5m, 15m, 1h, 1d, or always");
  });

  test("rejects a step that runs on machines its human step does not", async () => {
    const human = [{ id: "coder", say: "Sign in to Coder", probe: ["coder", "whoami"], on: ["darwin"] }];
    expect(loadPacks(sourceWith({ base: { ...base, human, steps: [{ id: "start", run: ["start"], after: "coder", on: ["darwin"] }] } }))).resolves.toHaveLength(1);
    expect(loadPacks(sourceWith({ base: { ...base, human, steps: [{ id: "start", run: ["start"], after: "coder" }] } }))).rejects.toThrow("steps start: runs where its human step coder does not; give it the same on");
  });

  test("rejects a job that waits for a human step the pack does not declare, or runs where that step does not", async () => {
    const human = [{ id: "token", say: "Save the token", probe: ["check-token"], roles: ["hub", "solo"] }];
    const job = { id: "listen", command: ["listen"], schedule: { every: "always" }, after: "token", roles: ["hub", "solo"] };
    await expect(loadPacks(sourceWith({ base: { ...base, human, jobs: [job] } }))).resolves.toHaveLength(1);
    await expect(loadPacks(sourceWith({ base: { ...base, human, jobs: [{ ...job, after: "github" }] } }))).rejects.toThrow("jobs listen: after must name a human step of this pack");
    await expect(loadPacks(sourceWith({ base: { ...base, human, jobs: [{ ...job, roles: ["hub", "solo", "devbox"] }] } }))).rejects.toThrow("jobs listen: runs where its human step token does not; give it the same roles");
  });

  test("lets a config entry wait for a check of its pack, but only where that check runs", async () => {
    const checks = [{ id: "proxy-up", run: ["proxy-check"], say: "The proxy is down.", roles: ["devbox"] }];
    const entry = { provider: "claude", key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", after: "proxy-up", roles: ["devbox"] };
    await expect(loadPacks(sourceWith({ base: { ...base, checks, config: [entry] } }))).resolves.toHaveLength(1);
    await expect(loadPacks(sourceWith({ base: { ...base, checks, config: [{ ...entry, after: "proxy-gone" }] } }))).rejects.toThrow("config env.ANTHROPIC_BASE_URL: after must name a human step or a check of this pack");
    await expect(loadPacks(sourceWith({ base: { ...base, checks, config: [{ ...entry, roles: ["devbox", "hub"] }] } }))).rejects.toThrow("config env.ANTHROPIC_BASE_URL: runs where its check proxy-up does not; give it the same roles");
    await expect(loadPacks(sourceWith({ base: { ...base, checks, steps: [{ id: "start", run: ["start"], after: "proxy-up", roles: ["devbox"] }] } }))).rejects.toThrow("steps start: after must name a human step of this pack");
  });

  test("rejects malformed nested items with a clear error", async () => {
    const setting = base.settings[0];
    const row = { role: "review", work: "Review", provider: "codex", model: "m", effort: "high" };
    const task = { prompt: "Run the loop.", projectSetting: "base.project", modelRole: "worker", workspaceStrategy: "worktree", runtimeMode: "auto" };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ settings: [{ ...setting, default: "two" }] }, "settings base.heavySlots: default does not fit type number"],
      [{ settings: [{ ...setting, type: "choice", choices: "a,b" }] }, "choices must list a value and a label each"],
      [{ jobs: [{ ...base.jobs[0], runner: "t3", task: {} }] }, "task needs a prompt, a projectSetting, and a modelRole"],
      [{ jobs: [{ ...base.jobs[0], runner: "t3", task: { ...task, schedule: "daily" } }] }, "drop task.id and task.schedule"],
      [{ steps: [null] }, "steps[0] must be an object"],
      [{ guides: [{ guide: "../../escape", path: "g.md" }] }, "guide must be lowercase words joined by dashes"],
      [{ steps: [{ id: "cli", run: ["true"], plans: ["gemini"] }] }, "steps cli: plans must list claude, codex, or both"],
      [{ jobs: [{ ...base.jobs[0], oncePerFleet: "yes" }] }, "oncePerFleet must be true or false"],
      [{ files: [{ path: "hook.ts" }] }, "files [0]: needs a path and a target"],
      [{ files: [{ path: "hook.ts", target: ".hook.ts", workflow: "nope" }] }, "files .hook.ts names unknown workflow nope"],
      [{ models: { gemini: [] } }, "models must map claude, codex, or both to rows"],
      [{ models: { claude: [{ role: "review", work: "Review", provider: "claude", model: "m", effort: "huge" }] } }, "each row needs a role, work"],
      [{ models: { claude: [row, row] } }, "models claude: role review is listed twice"],
    ];
    for (const [fields, message] of cases) {
      expect(loadPacks(sourceWith({ base: { ...base, ...fields } }))).rejects.toThrow(message);
    }
    const jobs = [{ ...base.jobs[0], runner: "t3", task }];
    expect((await loadPacks(sourceWith({ base: { ...base, jobs } })))[0]?.manifest.jobs?.[0]?.task?.prompt).toBe("Run the loop.");
  });
});
