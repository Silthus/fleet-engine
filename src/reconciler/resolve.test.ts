import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import type { AvailableSource, FetchedSource, MachineFile, MachineRole, PackManifest, Plan, Profile } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
import { apply, check } from "./apply.ts";
import { resolve, ResolveError } from "./resolve.ts";

const fixtures = join(import.meta.dir, "fixtures");
let engine: AvailableSource;
let agentSkills: FetchedSource;

beforeAll(async () => {
  const dir = join(fixtures, "engine");
  engine = { ref: { name: "engine", repo: "Silthus/fleet-engine", ref: "v0.1.0" }, dir, packs: await loadPacks(dir) };
  agentSkills = { ref: { name: "agent-skills", repo: "Silthus/agent-skills", ref: "v1" }, dir: join(fixtures, "agent-skills"), packs: [] };
});

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    schema: 1,
    dir: "/profile",
    engine: { repo: "Silthus/fleet-engine", ref: "v0.1.0", channel: "release" },
    sources: [],
    packs: ["pull-requests", "orchestration"],
    plan: "both",
    settings: { "pull-requests.reviewer": "other", "orchestration.tracker": "me/fleet-profile" },
    workflows: {},
    ...overrides,
  };
}

const mac: MachineFile = { schema: 1, role: "mac" };
const devbox: MachineFile = { schema: 1, role: "devbox" };

function plan(overrides: Partial<Profile> = {}, machine = mac, sources = [engine, agentSkills]) {
  return resolve(profile(overrides), machine, sources);
}

function file(result: Plan, target: string) {
  const found = result.files.find((item) => item.target === target);
  if (!found || !("content" in found)) throw new Error(`no content file ${target}`);
  return found.content;
}

function withPack(manifest: PackManifest, files: Record<string, string> = {}): AvailableSource {
  const dir = temp.make("source-");
  const packDir = join(dir, "packs", manifest.name);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "pack.json"), JSON.stringify(manifest));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(packDir, path, ".."), { recursive: true });
    writeFileSync(join(packDir, path), content);
  }
  return { ref: { name: manifest.name, repo: dir, ref: "v1" }, dir, packs: [{ manifest, dir: packDir }] };
}

const temp = tempDirs();

describe("resolve", () => {
  test("builds AGENTS.md from fragments in pack order with about me last", () => {
    const content = file(plan({ aboutMe: "I review every diff.\n" }), ".agents/AGENTS.md");
    expect(content).toBe("# Agent rules\n\nConfirm before a destructive action.\n\n## Pull requests\n\nOpen every pull request as a draft.\n\n## About me\n\nI review every diff.\n");
    expect(file(plan(), ".codex/AGENTS.md")).toBe(file(plan(), ".claude/rules/fleet.md"));
  });

  test("appends named sections from other packs to the owning guide", () => {
    expect(file(plan(), ".agents/guides/coding-standards.md")).toBe("# Coding standards\n\nKeep it simple.\n\n## Pull requests\n\nKeep each pull request under 400 lines.\n");
  });

  test("throws when two packs own the same guide", () => {
    const rival = withPack({ schema: 1, name: "rival", summary: "Rival.", guides: [{ guide: "coding-standards", path: "g.md" }] }, { "g.md": "x" });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, rival])).toThrow("guide coding-standards is owned by both base and rival");
  });

  test("writes skill settings from answers and defaults and lists what is unanswered", () => {
    const result = plan({ settings: { "pull-requests.reviewer": "other" } });
    const settings = file(result, ".agents/guides/skill-settings.md");
    expect(settings).toContain("- `base.heavySlots`: `2`. How many heavy commands may run at once?");
    expect(settings).toContain("- `pull-requests.reviewer`: `other`.");
    expect(result.unanswered.map((setting) => setting.key)).toEqual(["orchestration.tracker"]);
  });

  test("links pack skills and skills from another source", () => {
    const links = plan().files.filter((item) => "source" in item);
    expect(links).toEqual([
      { target: ".agents/skills/full-stop", source: join(fixtures, "engine/packs/pull-requests/skills/full-stop") },
      { target: ".claude/skills/full-stop", source: join(fixtures, "engine/packs/pull-requests/skills/full-stop") },
      { target: ".agents/skills/writing-voice", source: join(fixtures, "agent-skills/skills/communication/writing-voice") },
      { target: ".claude/skills/writing-voice", source: join(fixtures, "agent-skills/skills/communication/writing-voice") },
    ]);
  });

  test("lets a profile skill replace a pack skill of the same name", () => {
    const dir = temp.make("profile-");
    mkdirSync(join(dir, "skills/writing-voice"), { recursive: true });
    const result = plan({ dir, overrides: { skills: ["skills/writing-voice"] } });
    expect(result.files.filter((item) => item.target.endsWith("/writing-voice"))).toEqual([
      { target: ".agents/skills/writing-voice", source: join(dir, "skills/writing-voice") },
      { target: ".claude/skills/writing-voice", source: join(dir, "skills/writing-voice") },
    ]);
    expect(result.dropped).toContainEqual({ pack: "pull-requests", item: "skill agent-skills:communication/writing-voice", reason: "your profile replaces it" });
  });

  test("drops skills of an unreachable source with a reason", () => {
    const result = plan({}, mac, [engine, { ref: agentSkills.ref, error: "offline" }]);
    expect(result.files.some((item) => item.target.endsWith("writing-voice"))).toBe(false);
    expect(result.dropped).toContainEqual({ pack: "pull-requests", item: "skill agent-skills:communication/writing-voice", reason: "its source is unreachable" });
  });

  test("gives each config key one owner and throws on a clash", () => {
    expect(plan().owners).toEqual({ "claude:permissions.defaultMode": "base" });
    const rival = withPack({ schema: 1, name: "rival", summary: "Rival.", config: [{ provider: "claude", key: "permissions.defaultMode", value: "plan" }] });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, rival])).toThrow(new ResolveError("claude:permissions.defaultMode is owned by both base and rival"));
  });

  test("lets the profile override a pack's config key", () => {
    const result = plan({ overrides: { config: [{ provider: "claude", key: "permissions.defaultMode", value: "plan" }] } });
    expect(result.owners["claude:permissions.defaultMode"]).toBe("profile");
    expect(result.config).toEqual([{ provider: "claude", key: "permissions.defaultMode", value: "plan", pack: "profile" }]);
  });

  test("orders packs by requires and drops a pack whose requirement is missing", () => {
    expect(plan({ packs: ["orchestration", "pull-requests"] }).packs.map((pack) => pack.name)).toEqual(["base", "pull-requests", "orchestration"]);
    const result = plan({ packs: ["orchestration"] });
    expect(result.packs.find((pack) => pack.name === "orchestration")).toMatchObject({ available: false, reason: "requires pull-requests" });
    expect(result.packs.map((pack) => pack.name)).toEqual(["base", "orchestration"]);
  });

  test("throws on a requires cycle", () => {
    const a = withPack({ schema: 1, name: "a", summary: "A.", requires: ["b"] });
    const b = withPack({ schema: 1, name: "b", summary: "B.", requires: ["a"] });
    expect(() => plan({ packs: ["a", "b"] }, mac, [engine, a, b])).toThrow("packs require each other in a cycle");
  });

  test("activates workflows from overrides, defaults, and needs", () => {
    const onMac = plan({ workflows: { prune: false, "quality-loop": true } });
    expect(onMac.workflows).toEqual([
      { id: "prune", pack: "base", active: false, reason: "turned off" },
      { id: "draft-prs", pack: "pull-requests", active: true },
      { id: "maps", pack: "orchestration", active: true },
      { id: "quality-loop", pack: "orchestration", active: false, reason: "needs devbox" },
      { id: "boxes", pack: "orchestration", active: false, reason: "needs hub" },
    ]);
    expect(onMac.jobs).toEqual([]);
    expect(onMac.dropped).toContainEqual({ pack: "orchestration", item: "job box-pool", reason: "workflow boxes is off" });

    const onDevbox = plan({ workflows: { "quality-loop": true }, settings: { ...profile().settings, "orchestration.loopProject": "fleet" } }, devbox);
    expect(onDevbox.jobs.map((job) => job.id)).toEqual(["prune", "quality-loop"]);
    expect(plan({ devboxes: ["my-box"], workflows: { "quality-loop": true } }).jobs.map((job) => job.id)).toContain("quality-loop");
  });

  test("leaves the settings of an inactive workflow out", () => {
    expect(plan().unanswered.map((setting) => setting.key)).not.toContain("orchestration.loopProject");
    expect(plan({ workflows: { "quality-loop": true } }, devbox).unanswered.map((setting) => setting.key)).toEqual(["orchestration.loopProject"]);
  });

  test("keeps a setting that two workflows share while one of them is on", () => {
    const loops = withPack({
      schema: 1,
      name: "loops",
      summary: "Loops.",
      settings: [{ key: "loops.project", question: "Which project?", type: "string" }],
      workflows: [
        { id: "night", name: "Night", sentence: "Runs at night.", default: true, settings: ["loops.project"] },
        { id: "morning", name: "Morning", sentence: "Runs in the morning.", default: false, settings: ["loops.project"] },
      ],
    });
    const result = plan({ packs: ["loops"], settings: { "loops.project": "fleet" } }, mac, [engine, loops]);
    expect(result.settings["loops.project"]).toBe("fleet");
    expect(plan({ packs: ["loops"] }, mac, [engine, loops]).unanswered.map((setting) => setting.key)).toEqual(["loops.project"]);
    expect(plan({ packs: ["loops"], workflows: { night: false } }, mac, [engine, loops]).unanswered).toEqual([]);
  });

  test("keeps a setting that another pack's active workflow lists", () => {
    const owner = withPack({ schema: 1, name: "owner", summary: "Owner.", settings: [{ key: "owner.project", question: "Which project?", type: "string" }], workflows: [{ id: "owned", name: "Owned", sentence: "Owned.", default: false, settings: ["owner.project"] }] });
    const user = withPack({ schema: 1, name: "user", summary: "User.", workflows: [{ id: "borrowed", name: "Borrowed", sentence: "Borrowed.", default: true, settings: ["owner.project"] }] });
    const result = plan({ packs: ["owner", "user"] }, mac, [engine, owner, user]);
    expect(result.unanswered.map((setting) => setting.key)).toEqual(["owner.project"]);
  });

  test("a workflow stays off while a workflow it requires is off, also through a chain, and a cycle that is all on stays on", () => {
    const flow = (id: string, requires: string[]) => ({ id, name: id, sentence: `${id}.`, default: true, requires });
    const chain = withPack({ schema: 1, name: "chain", summary: "Chain.", workflows: [flow("top", ["middle"]), flow("middle", ["bottom"]), flow("bottom", []), flow("ping", ["pong"]), flow("pong", ["ping"])] });
    const states = (workflows: Record<string, boolean>) => plan({ packs: ["chain"], workflows }, mac, [engine, chain]).workflows.filter((state) => state.pack === "chain").map(({ id, active, reason }) => [id, active, reason]);
    expect(states({ bottom: false })).toEqual([["top", false, "needs workflow middle"], ["middle", false, "needs workflow bottom"], ["bottom", false, "turned off"], ["ping", true, undefined], ["pong", true, undefined]]);
    expect(states({ pong: false }).slice(3)).toEqual([["ping", false, "needs workflow pong"], ["pong", false, "turned off"]]);
  });

  test("limits items by os and role", () => {
    expect(plan({ packs: ["posthog"] }).human.map((step) => step.id)).toEqual(["coder"]);
    expect(plan({ packs: ["posthog"] }, devbox).human).toEqual([]);
  });

  test("discovers pack commands and rejects reserved names and clashes", () => {
    expect(plan({ packs: ["hub"] }).commands).toEqual({ box: { pack: "hub", path: join(fixtures, "engine/packs/hub/commands/box.ts") } });
    expect(plan().commands).toEqual({});
    const reserved = withPack({ schema: 1, name: "rival", summary: "Rival." }, { "commands/doctor.ts": "export {};\n" });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, reserved])).toThrow("rival: command doctor is reserved by the engine");
    const clash = withPack({ schema: 1, name: "rival", summary: "Rival." }, { "commands/box.ts": "export {};\n" });
    expect(() => plan({ packs: ["hub", "rival"] }, mac, [engine, clash])).toThrow("command box is shipped by both hub and rival");
  });

  test("collects the handlers of enabled packs by seam, and rejects two for one seam", () => {
    const bots = withPack({ schema: 1, name: "bots", summary: "Bots.", handlers: [{ seam: "review-bot", path: "lib/bot.ts" }] }, { "lib/bot.ts": "export {};\n" });
    expect(plan().handlers).toEqual({});
    expect(plan({ packs: ["bots"] }, mac, [engine, bots]).handlers).toEqual({ "review-bot": { pack: "bots", path: join(bots.dir, "packs/bots/lib/bot.ts") } });
    const linuxOnly = withPack({ schema: 1, name: "bots", summary: "Bots.", handlers: [{ seam: "review-bot", path: "lib/bot.ts", on: ["linux"] }] });
    expect(plan({ packs: ["bots"] }, mac, [engine, linuxOnly]).handlers).toEqual({});
    const rival = withPack({ schema: 1, name: "rival", summary: "Rival.", handlers: [{ seam: "review-bot", path: "lib/bot.ts" }] });
    expect(() => plan({ packs: ["bots", "rival"] }, mac, [engine, bots, rival])).toThrow("the review-bot handler is declared by both bots and rival");
    const leak = withPack({ schema: 1, name: "bots", summary: "Bots.", handlers: [{ seam: "review-bot", path: "../../../outside.ts" }] });
    expect(() => plan({ packs: ["bots"] }, mac, [engine, leak])).toThrow("bots: path ../../../outside.ts leaves its pack");
    const missing = withPack({ schema: 1, name: "bots", summary: "Bots.", handlers: [{ seam: "review-bot", path: "lib/missing.ts" }] });
    expect(() => plan({ packs: ["bots"] }, mac, [engine, missing])).toThrow("bots: the review-bot handler lib/missing.ts is not a file");
    const folder = withPack({ schema: 1, name: "bots", summary: "Bots.", handlers: [{ seam: "review-bot", path: "lib" }] }, { "lib/bot.ts": "export {};\n" });
    expect(() => plan({ packs: ["bots"] }, mac, [engine, folder])).toThrow("bots: the review-bot handler lib is not a file");
  });

  test("marks a pack of an unreachable source as unavailable", () => {
    const result = plan({ packs: ["team"] }, mac, [engine, agentSkills, { ref: { name: "team", repo: "org/team", ref: "v1" }, error: "offline" }]);
    expect(result.packs).toContainEqual({ name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" });
  });
});

describe("resolve without the hub pack", () => {
  const pointsAtHub = /\bhub\b|tunnel|proxy|ANTHROPIC_BASE_URL|127\.0\.0\.1/i;
  const optional = ["pull-requests", "orchestration", "posthog"];
  const workflowIds = ["prune", "draft-prs", "maps", "quality-loop", "boxes"];
  const roles: MachineRole[] = ["mac", "devbox", "linux"];

  function random(seed: number) {
    return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  }

  function hubFree(result: Plan) {
    const { jobs, human, steps, checks, config, files, commands } = result;
    return !pointsAtHub.test(JSON.stringify({ jobs, human, steps, checks, config, files, commands }));
  }

  test("no planned item points at a hub, tunnel, or proxy, and resolve stays under 50 ms", () => {
    const next = random(42);
    for (let run = 0; run < 200; run++) {
      const packs = optional.filter(() => next() < 0.6);
      const workflows = Object.fromEntries(workflowIds.filter(() => next() < 0.5).map((id) => [id, next() < 0.5]));
      const machine: MachineFile = { schema: 1, role: roles[Math.floor(next() * roles.length)] ?? "mac" };
      const started = performance.now();
      const result = plan({ packs, workflows, devboxes: next() < 0.5 ? ["box"] : [] }, machine);
      expect(performance.now() - started).toBeLessThan(50);
      expect(hubFree(result)).toBe(true);
    }
    expect(hubFree(plan({ packs: ["hub", "orchestration", "pull-requests"] }, devbox))).toBe(false);
  });
});

describe("resolve guards", () => {
  const pack = (name: string, fields: Partial<PackManifest> = {}): PackManifest => ({ schema: 1, name, summary: `${name}.`, ...fields });

  test("keeps every target inside the home directory", () => {
    const escape = withPack(pack("escape", { guides: [{ guide: "../../../../tmp/escape", path: "g.md" }] }), { "g.md": "x" });
    expect(() => plan({ packs: ["escape"] }, mac, [engine, escape])).toThrow("target .agents/guides/../../../../tmp/escape.md leaves the home directory");
  });

  test("refuses instructions, skills, and commands that link outside their pack", () => {
    const outside = temp.make("outside-");
    writeFileSync(join(outside, "secret.md"), "outside\n");
    mkdirSync(join(outside, "skill"));
    const linked = (manifest: PackManifest, link: string, target: string) => {
      const source = withPack(manifest);
      const packDir = join(source.dir, "packs", manifest.name);
      mkdirSync(join(packDir, link, ".."), { recursive: true });
      symlinkSync(target, join(packDir, link));
      return source;
    };
    const cases: Array<[PackManifest, string, string]> = [
      [pack("rules", { instructions: "rules.md" }), "rules.md", join(outside, "secret.md")],
      [pack("skills", { skills: ["skills/leak"] }), "skills/leak", join(outside, "skill")],
      [pack("tools"), "commands/leak.ts", join(outside, "secret.md")],
    ];
    for (const [manifest, link, target] of cases) {
      expect(() => plan({ packs: [manifest.name] }, mac, [engine, linked(manifest, link, target)])).toThrow("links outside its pack");
    }
  });

  test("refuses a pack file that is a broken link, so it cannot point outside later", () => {
    const source = withPack(pack("dangling", { files: [{ path: "hook.ts", target: ".config/fleet/hooks/hook.ts" }] }));
    symlinkSync(join(temp.make("outside-"), "later.ts"), join(source.dir, "packs/dangling/hook.ts"));
    expect(() => plan({ packs: ["dangling"] }, mac, [engine, source])).toThrow("dangling: path hook.ts is a broken link");
  });

  test("refuses a pack file on a file that the provider config owns", () => {
    const rival = withPack(pack("rival", { files: [{ path: "settings.json", target: ".claude/settings.json" }] }), { "settings.json": "{}" });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, rival])).toThrow(".claude/settings.json belongs to the provider config");
  });

  test("rejects a workflow id or a job id that two packs declare", () => {
    const sync = { id: "sync", name: "Sync", sentence: "Sync.", default: true };
    const one = withPack(pack("one", { workflows: [{ ...sync, needs: ["hub"] }] }));
    const two = withPack(pack("two", { workflows: [sync] }));
    expect(() => plan({ packs: ["one", "two"] }, mac, [engine, one, two])).toThrow("workflow sync is declared by both one and two");
    const prune = withPack(pack("prune", { jobs: [{ id: "prune", command: ["true"], schedule: { every: "1d" } }] }));
    expect(() => plan({ packs: ["prune"] }, mac, [engine, prune])).toThrow("job prune is declared by both base and prune");
  });

  test("plans T3 project scripts by scope, owned by their pack", () => {
    const script = { id: "prepare", name: "Prepare worktree", command: "fleet prepare", projects: ["~/app"] };
    const team = withPack(pack("team", { t3ProjectScripts: [{ ...script, roles: ["devbox"] }, { ...script, id: "mac-only", on: ["darwin"] }] }));
    expect(plan({ packs: ["team"] }, devbox, [engine, team]).t3ProjectScripts).toEqual([{ ...script, roles: ["devbox"], pack: "team" }]);
    expect(plan({ packs: ["team"] }, mac, [engine, team]).t3ProjectScripts).toEqual([{ ...script, id: "mac-only", on: ["darwin"], pack: "team" }]);
  });

  test("adds the path a T3 project script's setting names to its projects", () => {
    const script = { id: "prepare", name: "Prepare worktree", command: "fleet prepare", projects: ["~/app"], projectSetting: "team.checkout" };
    const team = withPack(pack("team", { settings: [{ key: "team.checkout", question: "Where is the checkout?", type: "string", default: "~/dev/app", ask: "never" }], t3ProjectScripts: [script] }));
    expect(plan({ packs: ["team"] }, mac, [engine, team]).t3ProjectScripts).toEqual([{ ...script, projects: ["~/app", "~/dev/app"], pack: "team" }]);
    expect(plan({ packs: ["team"], settings: { "team.checkout": "~/app" } }, mac, [engine, team]).t3ProjectScripts).toEqual([{ ...script, pack: "team" }]);
    expect(plan({ packs: ["team"], settings: { "team.checkout": "app" } }, mac, [engine, team]).t3ProjectScripts).toEqual([{ ...script, pack: "team" }]);
  });

  test("rejects two T3 project scripts that would get the same id", () => {
    const script = { id: "prepare", name: "Prepare worktree", command: "fleet prepare", projects: ["~/app"] };
    const team = withPack(pack("team", { t3ProjectScripts: [{ ...script, id: "extra-prepare" }] }));
    const teamExtra = withPack(pack("team-extra", { t3ProjectScripts: [script] }));
    expect(() => plan({ packs: ["team", "team-extra"] }, mac, [engine, team, teamExtra])).toThrow(new ResolveError("t3 project script prepare of team-extra and extra-prepare of team both get the id fleet-team-extra-prepare"));
    const twice = withPack(pack("twice", { t3ProjectScripts: [script, { ...script, name: "Again" }] }));
    expect(() => plan({ packs: ["twice"] }, mac, [engine, twice])).toThrow(new ResolveError("t3 project script prepare of twice and prepare of twice both get the id fleet-twice-prepare"));
  });

  test("keeps the AI plan and resolves a T3 job's project", () => {
    expect(plan({ plan: "claude" }).ai).toBe("claude");
    const result = plan({ workflows: { "quality-loop": true }, settings: { "orchestration.tracker": "me/maps", "orchestration.loopProject": "chosen-project" } }, devbox);
    expect(result.jobs.find((job) => job.id === "quality-loop")?.task?.project).toBe("chosen-project");
  });

  test("throws when the base pack is not available", () => {
    const base = engine.packs.find((item) => item.manifest.name === "base");
    if (!base) throw new Error("no base fixture");
    const broken: AvailableSource = { ...engine, packs: [{ ...base, manifest: { ...base.manifest, requires: ["hub"] } }] };
    expect(() => resolve(profile({ packs: [] }), mac, [broken])).toThrow("the base pack is not available: requires hub");
  });

  test("reserves the skill-settings guide for the engine", () => {
    const rival = withPack(pack("rival", { guides: [{ guide: "skill-settings", path: "g.md" }] }), { "g.md": "x" });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, rival])).toThrow("rival: guide skill-settings is written by the engine");
  });

  test("drops a profile config override whose workflow is off", () => {
    const result = plan({ workflows: { prune: false }, overrides: { config: [{ provider: "claude", key: "model", value: "x", workflow: "prune" }] } });
    expect(result.config.some((entry) => entry.key === "model")).toBe(false);
    expect(result.dropped).toContainEqual({ pack: "profile", item: "config claude:model", reason: "workflow prune is off" });
  });
});

describe("resolve per AI plan", () => {
  const rows = (model: string) => [
    { role: "implementation", work: "Implementation and tests", provider: "claude" as const, model, effort: "high" as const },
    { role: "review", work: "Review", provider: "codex" as const, model: "gpt-review", effort: "high" as const },
  ];
  const tables = withPack(
    {
      schema: 1,
      name: "models",
      summary: "Models.",
      instructions: "AGENTS.md",
      models: { claude: rows("claude-only"), both: rows("claude-both") },
      config: [
        { provider: "t3", key: "defaultModel", value: "claude-only", plans: ["claude"] },
        { provider: "t3", key: "defaultModel", value: "claude-both", plans: ["both"] },
      ],
      steps: [{ id: "codex-cli", run: ["install", "codex"], plans: ["codex", "both"], on: ["linux"] }],
      files: [
        { path: "hooks/guard.ts", target: ".config/fleet/hooks/guard.ts" },
        { path: "heavy.slice", target: ".config/systemd/user/fleet-heavy.slice", on: ["linux"] },
      ],
    },
    { "AGENTS.md": "# Models fragment\n", "hooks/guard.ts": "export {};\n", "heavy.slice": "[Slice]\n" },
  );
  const withTables = (overrides: Partial<Profile> = {}, machine = mac) => plan({ packs: ["pull-requests", "orchestration", "models"], ...overrides }, machine, [engine, agentSkills, tables]);

  test("refuses a T3 job whose model role the plan's model table lacks", () => {
    const task = { prompt: "Run.", projectSetting: "jobs.project", modelRole: "worker", workspaceStrategy: "worktree" as const, runtimeMode: "auto" as const };
    const jobs = withPack({ schema: 1, name: "jobs", summary: "Jobs.", settings: [{ key: "jobs.project", question: "Which project?", type: "string", default: "fleet" }], jobs: [{ id: "nightly", command: [], runner: "t3", schedule: { every: "1d" }, task }] });
    const resolveJobs = (overrides: Partial<Profile> = {}) => plan({ packs: ["pull-requests", "orchestration", "models", "jobs"], ...overrides }, mac, [engine, agentSkills, tables, jobs]);
    expect(() => resolveJobs()).toThrow("job nightly asks for model role worker, which the model table lacks");
    const worker = { role: "worker", work: "Workers", provider: "claude" as const, model: "claude-worker", effort: "high" as const };
    expect(resolveJobs({ overrides: { models: [worker] } }).jobs.map((job) => job.id)).toContain("nightly");
  });

  test("keeps only the items whose plans hold and records why the others dropped", () => {
    const claude = withTables({ plan: "claude" }, devbox);
    expect(claude.config.filter((entry) => entry.key === "defaultModel").map((entry) => entry.value)).toEqual(["claude-only"]);
    expect(claude.steps.map((step) => step.id)).toEqual([]);
    expect(claude.dropped).toContainEqual({ pack: "models", item: "step codex-cli", reason: "not for plan claude" });
    expect(withTables({ plan: "both" }, devbox).steps.map((step) => step.id)).toEqual(["codex-cli"]);
  });

  test("fills the plan's model table and renders it after the owning pack's fragment", () => {
    const result = withTables({ plan: "both" });
    expect(result.models.map((row) => row.model)).toEqual(["claude-both", "gpt-review"]);
    const agents = file(result, ".agents/AGENTS.md");
    expect(agents).toContain("# Models fragment\n\n## Model selection\n\n| Work | Model | Effort |\n| --- | --- | --- |\n| Implementation and tests | `claude-both` | high |\n| Review | `gpt-review` | high |\n");
    expect(agents.indexOf("## Model selection")).toBeLessThan(agents.indexOf("## About me") < 0 ? Infinity : agents.indexOf("## About me"));
  });

  test("has no model table for a plan the pack leaves out", () => {
    const result = withTables({ plan: "codex" });
    expect(result.models).toEqual([]);
    expect(file(result, ".agents/AGENTS.md")).not.toContain("## Model selection");
  });

  test("lets the profile replace a row by role or add one", () => {
    const extra = { role: "lookup", work: "Lookups", provider: "claude" as const, model: "small", effort: "medium" as const };
    const replaced = { ...rows("mine")[0]! };
    const result = withTables({ plan: "both", overrides: { models: [replaced, extra] } });
    expect(result.models.map((row) => `${row.role}=${row.model}`)).toEqual(["implementation=mine", "review=gpt-review", "lookup=small"]);
  });

  test("throws when two packs declare a model table", () => {
    const rival = withPack({ schema: 1, name: "rival", summary: "Rival.", models: { claude: rows("rival") } });
    expect(() => plan({ packs: ["models", "rival"] }, mac, [engine, agentSkills, tables, rival])).toThrow("the model table is declared by both models and rival");
  });

  test("links pack files into the home directory, limited by os", () => {
    const links = (result: Plan) => result.files.filter((item) => "source" in item && item.target.startsWith(".config/"));
    expect(links(withTables({}, devbox))).toEqual([
      { target: ".config/fleet/hooks/guard.ts", source: join(tables.dir, "packs/models/hooks/guard.ts") },
      { target: ".config/systemd/user/fleet-heavy.slice", source: join(tables.dir, "packs/models/heavy.slice") },
    ]);
    expect(links(withTables()).map((item) => item.target)).toEqual([".config/fleet/hooks/guard.ts"]);
  });

  test("refuses a pack file that leaves its pack or the home directory", () => {
    const outside = withPack({ schema: 1, name: "rival", summary: "Rival.", files: [{ path: "../x", target: ".x" }] });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, outside])).toThrow("rival: path ../x leaves its pack");
    const away = withPack({ schema: 1, name: "rival", summary: "Rival.", files: [{ path: "x", target: "../x" }] }, { x: "x" });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, away])).toThrow("target ../x leaves the home directory");
  });
});

describe("a step's undo", () => {
  const step = { id: "auto-box", run: ["box-on"], check: ["box-is-on"], undo: ["box-off"], workflow: "boxes" };
  const signIn = { id: "sign-in", say: "Sign in to the box service.", probe: ["signed-in"], workflow: "boxes" };
  const team = (steps: PackManifest["steps"]) => withPack({ schema: 1, name: "team", summary: "Team.", workflows: [{ id: "boxes", name: "Boxes", sentence: "Boxes.", default: true }], human: [signIn], steps });
  const box = (on: boolean, undo = 0) => {
    const world = { on, signedIn: true };
    const run = async (command: string[]) => {
      const name = command.join(" ");
      if (name === "box-is-on") return world.on ? 0 : 1;
      if (name === "box-state") return world.signedIn ? (world.on ? 0 : 1) : 3;
      if (name === "box-unsure") return 3;
      if (name === "box-on") return (world.on = true), 0;
      if (name === "box-off") return undo || ((world.on = false), 0);
      if (name === "signed-in") return world.signedIn ? 0 : 1;
      if (name === "broken") return 1;
      return 0;
    };
    return { world, run };
  };
  const planWith = (steps: PackManifest["steps"], workflows: Record<string, boolean>, machine = devbox) => plan({ packs: ["team"], workflows }, machine, [engine, team(steps)]);

  test("runs once the step's workflow is off and its check shows what it set, and doctor reports it until then", async () => {
    const { world, run } = box(true);
    const off = planWith([step], { boxes: false });
    const home = temp.make("home-");
    expect((await check(off, { home, run })).findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "The workflow boxes is off, but step auto-box of the team pack still holds what it set. Run fleet apply to undo it.", repair: "apply" });
    const applied = await apply(off, { home, run });
    expect(world.on).toBe(false);
    expect(applied.actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "workflow boxes is off" });
    expect((await apply(off, { home, run })).actions.filter((action) => action.target.startsWith("step "))).toEqual([]);
    expect((await check(off, { home, run })).findings.map((finding) => finding.id)).not.toContain("undo:auto-box");
  });

  test("leaves the step alone while its workflow is on, or when it is off for another reason", async () => {
    const on = box(true);
    await apply(planWith([step], {}), { home: temp.make("home-"), run: on.run });
    expect(on.world.on).toBe(true);
    const elsewhere = box(true);
    await apply(planWith([{ ...step, on: ["darwin"] }], { boxes: false }), { home: temp.make("home-"), run: elsewhere.run });
    expect(elsewhere.world.on).toBe(true);
  });

  test("an undo that fails is reported, and the next apply tries again", async () => {
    const { world, run } = box(true, 1);
    const report = await apply(planWith([step], { boxes: false }), { home: temp.make("home-"), run });
    expect(world.on).toBe(true);
    expect(report.findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "Fleet could not undo step auto-box of the team pack, whose workflow boxes is off. The next fleet apply tries again.", repair: "apply" });
  });

  test("waits for the step's prerequisite and runs nothing in a pack whose step failed in this apply", async () => {
    const waiting = box(true);
    waiting.world.signedIn = false;
    const gated = planWith([{ ...step, after: "sign-in" }], { boxes: false });
    const home = temp.make("home-");
    expect((await apply(gated, { home, run: waiting.run })).actions.filter((action) => action.target.startsWith("step "))).toEqual([]);
    expect(waiting.world.on).toBe(true);
    expect((await check(gated, { home, run: waiting.run })).findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "Step auto-box of the team pack waits for sign-in before Fleet can undo it.", repair: "human" });
    waiting.world.signedIn = true;
    await apply(gated, { home, run: waiting.run });
    expect(waiting.world.on).toBe(false);
    const broken = box(true);
    await apply(planWith([{ id: "broken", run: ["broken"], check: ["broken"] }, step], { boxes: false }), { home: temp.make("home-"), run: broken.run });
    expect(broken.world.on).toBe(true);
  });

  test("a check that cannot tell before the prerequisite passes leaves a note that keeps doctor green, and the undo runs once it passes", async () => {
    const blind = box(true);
    blind.world.signedIn = false;
    const gated = planWith([{ ...step, check: ["box-state"], after: "sign-in" }], { boxes: false });
    const home = temp.make("home-");
    const note = { id: "undo:auto-box", pack: "team", say: "Step auto-box of the team pack waits for sign-in before Fleet can undo it." };
    expect((await apply(gated, { home, run: blind.run })).findings).toContainEqual(note);
    expect(blind.world.on).toBe(true);
    const doctor = await check(gated, { home, run: blind.run });
    expect(doctor.findings).toContainEqual(note);
    expect(doctor.ok).toBe(true);
    blind.world.signedIn = true;
    await apply(gated, { home, run: blind.run });
    expect(blind.world.on).toBe(false);
  });

  test("a check that cannot tell once the prerequisite passes is a failure", async () => {
    const unsure = planWith([{ ...step, check: ["box-unsure"], after: "sign-in" }], { boxes: false });
    const home = temp.make("home-");
    const { world, run } = box(true);
    const finding = { id: "undo:auto-box", pack: "team", say: "Fleet cannot tell whether step auto-box of the team pack still holds what it set, though its workflow boxes is off.", repair: "apply" as const };
    expect((await apply(unsure, { home, run })).findings).toContainEqual(finding);
    expect(world.on).toBe(true);
    const doctor = await check(unsure, { home, run });
    expect(doctor.findings).toContainEqual(finding);
    expect(doctor.ok).toBe(false);
  });

  test("a dry run previews the undo without running it, and leaves out an undo that waits", async () => {
    const { world, run } = box(true);
    const gated = planWith([{ ...step, after: "sign-in" }], { boxes: false });
    const preview = await apply(gated, { home: temp.make("home-"), run, dryRun: true });
    expect(preview.actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "fleet apply would undo it: workflow boxes is off" });
    expect(world.on).toBe(true);
    world.signedIn = false;
    const waiting = await apply(gated, { home: temp.make("home-"), run, dryRun: true });
    expect(waiting.actions.filter((action) => action.target.startsWith("step "))).toEqual([]);
  });

  test("a Base step whose undo fails fails the apply", async () => {
    const off = planWith([step], { boxes: false });
    const base = { ...off, undo: off.undo!.map((item) => ({ ...item, pack: "base" })) };
    expect((await apply(base, { home: temp.make("home-"), run: box(true, 1).run })).ok).toBe(false);
    expect((await apply(off, { home: temp.make("home-"), run: box(true, 1).run })).ok).toBe(true);
  });

  test("a Base step whose check cannot tell fails the apply, but not while it waits for its prerequisite", async () => {
    const asBase = (steps: PackManifest["steps"]) => {
      const off = planWith(steps, { boxes: false });
      return { ...off, undo: off.undo!.map((item) => ({ ...item, pack: "base" })) };
    };
    expect((await apply(asBase([{ ...step, check: ["box-unsure"] }]), { home: temp.make("home-"), run: box(true).run })).ok).toBe(false);
    const waiting = box(true);
    waiting.world.signedIn = false;
    expect((await apply(asBase([{ ...step, check: ["box-state"], after: "sign-in" }]), { home: temp.make("home-"), run: waiting.run })).ok).toBe(true);
  });

  test("runs on the next apply after its pack leaves the profile, and doctor reports it until then", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    await apply(planWith([step], {}), { home, run });
    expect(world.on).toBe(true);
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, team([step])]);
    expect((await check(removed, { home, run })).findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "The team pack is off, but step auto-box of the team pack still holds what it set. Run fleet apply to undo it.", repair: "apply" });
    expect((await apply(removed, { home, run, dryRun: true })).actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "fleet apply would undo it: the team pack is off" });
    expect(world.on).toBe(true);
    expect((await apply(removed, { home, run })).actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "the team pack is off" });
    expect(world.on).toBe(false);
    world.on = true;
    expect((await apply(removed, { home, run })).actions.filter((action) => action.target.startsWith("step "))).toEqual([]);
    expect(world.on).toBe(true);
  });

  test("runs the undo the step had when it last applied, after a step left its pack's plan for a reason other than a workflow", async () => {
    const { world, run } = box(true);
    const home = temp.make("home-");
    await apply(planWith([{ ...step, workflow: undefined }], {}), { home, run });
    const moved = planWith([{ ...step, workflow: undefined, on: ["darwin"], undo: ["changed-undo"] }], {});
    const report = await apply(moved, { home, run });
    expect(report.actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "this machine no longer plans it" });
    expect(world.on).toBe(false);
  });

  test("leaves a step alone while its pack is in the profile but cannot be loaded, and never records a step it did not see hold", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    await apply(planWith([step], {}), { home, run });
    const outage = plan({ packs: ["team"], workflows: {} }, devbox, [engine]);
    expect((await apply(outage, { home, run })).actions.filter((action) => action.target.startsWith("step "))).toEqual([]);
    expect(world.on).toBe(true);
    const blocked = box(false);
    const fresh = temp.make("home-");
    await apply(planWith([{ ...step, after: "sign-in" }], {}), { home: fresh, run: async (command) => (command.join(" ") === "signed-in" ? 1 : blocked.run(command)) });
    blocked.world.on = true;
    await apply(plan({ packs: [], workflows: {} }, devbox, [engine, team([step])]), { home: fresh, run: blocked.run });
    expect(blocked.world.on).toBe(true);
  });

  test("waits for the prerequisite the step had when it applied, after its pack leaves", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    await apply(planWith([{ ...step, after: "sign-in" }], {}), { home, run });
    expect(world.on).toBe(true);
    world.signedIn = false;
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, team([step])]);
    expect((await apply(removed, { home, run })).findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "Step auto-box of the team pack waits for sign-in before Fleet can undo it.", repair: "human" });
    expect(world.on).toBe(true);
    world.signedIn = true;
    await apply(removed, { home, run });
    expect(world.on).toBe(false);
  });

  test("an undo that fails after its pack leaves is reported, and the next apply tries again", async () => {
    const failing = box(false, 1);
    const home = temp.make("home-");
    await apply(planWith([step], {}), { home, run: failing.run });
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, team([step])]);
    expect((await apply(removed, { home, run: failing.run })).findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "Fleet could not undo step auto-box of the team pack, which is off. The next fleet apply tries again.", repair: "apply" });
    const working = box(true);
    await apply(removed, { home, run: working.run });
    expect(working.world.on).toBe(false);
  });

  test("stops when the step ledger is not one, rather than forget what it would undo", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
    writeFileSync(join(home, ".local/state/fleet/steps.json"), JSON.stringify({ version: 1, steps: [{ pack: "team", id: "auto-box" }] }));
    await expect(apply(planWith([step], {}), { home, run: box(true).run })).rejects.toThrow(".local/state/fleet/steps.json is not a Fleet step ledger");
  });

  test("reads the step's left probe instead of its check, when the check also passes with nothing to hold", async () => {
    const { world, run } = box(true);
    const home = temp.make("home-");
    const doctored = { ...step, check: ["always-fine"], left: ["box-is-on"] };
    await apply(planWith([doctored], {}), { home, run });
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, team([doctored])]);
    expect((await apply(removed, { home, run })).actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "the team pack is off" });
    expect(world.on).toBe(false);
    expect((await apply(removed, { home, run })).findings.map((finding) => finding.id)).not.toContain("undo:auto-box");
    const workflowOff = box(true);
    expect((await apply(planWith([doctored], { boxes: false }), { home: temp.make("home-"), run: workflowOff.run })).actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "workflow boxes is off" });
    expect(workflowOff.world.on).toBe(false);
    await expect(loadPacks(team([{ ...step, left: ["box-is-on"], undo: undefined }]).dir)).rejects.toThrow("steps auto-box: left needs an undo");
    await expect(loadPacks(team([{ ...step, left: "box-is-on" as unknown as string[] }]).dir)).rejects.toThrow("steps auto-box: left must be a command list");
  });

  test("doctor names what a human step left once its pack is off, until a person removes it, and keeps doctor green", async () => {
    const { world, run } = box(true);
    const home = temp.make("home-");
    const leaving = team([]);
    leaving.packs[0]!.manifest.human = [{ ...signIn, undo: "Sign out with box logout." }];
    await apply(plan({ packs: ["team"], workflows: {} }, devbox, [engine, leaving]), { home, run });
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, leaving]);
    const note = { id: "left:sign-in", pack: "team", say: "The team pack is off. Sign out with box logout." };
    const doctor = await check(removed, { home, run });
    expect(doctor.findings).toContainEqual(note);
    expect(doctor.ok).toBe(true);
    world.signedIn = false;
    expect((await check(removed, { home, run })).findings).not.toContainEqual(note);
    const never = box(true);
    never.world.signedIn = false;
    const fresh = temp.make("home-");
    await apply(plan({ packs: ["team"], workflows: {} }, devbox, [engine, leaving]), { home: fresh, run: never.run });
    never.world.signedIn = true;
    expect((await check(removed, { home: fresh, run: never.run })).findings.map((finding) => finding.id)).not.toContain("left:sign-in");
    await expect(loadPacks(withPack({ schema: 1, name: "team", summary: "Team.", human: [{ ...signIn, undo: "" }] }).dir)).rejects.toThrow("human sign-in: undo must say what a person does");
  });

  test("doctor reads a human step's left probe once it leaves, keeps its record through a probe that fails while planned, and forgets it once nothing is left", async () => {
    const { world, run } = box(true);
    const home = temp.make("home-");
    const leaving = team([]);
    leaving.packs[0]!.manifest.human = [{ ...signIn, left: ["box-is-on"], undo: "Turn the box off by hand." }];
    const kept = plan({ packs: ["team"], workflows: {} }, devbox, [engine, leaving]);
    await apply(kept, { home, run });
    await apply(kept, { home, run: async (command) => (command.join(" ") === "signed-in" ? 127 : run(command)) });
    world.signedIn = false;
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, leaving]);
    const note = { id: "left:sign-in", pack: "team", say: "The team pack is off. Turn the box off by hand." };
    expect((await check(removed, { home, run })).findings).toContainEqual(note);
    world.on = false;
    await apply(removed, { home, run });
    world.on = true;
    expect((await check(removed, { home, run })).findings).not.toContainEqual(note);
    await expect(loadPacks(withPack({ schema: 1, name: "team", summary: "Team.", human: [{ ...signIn, left: ["box-is-on"] }] }).dir)).rejects.toThrow("human sign-in: left needs an undo");
  });

  test("records a human step from the probe the apply already ran", async () => {
    const { run } = box(true);
    const leaving = team([]);
    leaving.packs[0]!.manifest.human = [{ ...signIn, repair: ["sign-in-again"], undo: "Sign out with box logout." }];
    let probes = 0;
    const counted = async (command: string[]) => (command.join(" ") === "signed-in" && probes++, run(command));
    await apply(plan({ packs: ["team"], workflows: {} }, devbox, [engine, leaving]), { home: temp.make("home-"), run: counted });
    expect(probes).toBe(1);
  });

  test("doctor names the secrets folder of a pack that is off, and keeps it", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet/secrets/team"), { recursive: true });
    mkdirSync(join(home, ".config/fleet/secrets/not a pack"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/secrets/team/token"), "secret");
    const note = { id: "secrets:team", pack: "team", say: "The team pack is off. Its secrets stay in ~/.config/fleet/secrets/team. Delete that folder when you no longer need them." };
    expect((await check(planWith([], {}), { home, run: box(true).run })).findings).not.toContainEqual(note);
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, team([])]);
    await apply(removed, { home, run: box(true).run });
    expect(readFileSync(join(home, ".config/fleet/secrets/team/token"), "utf8")).toBe("secret");
    const doctor = await check(removed, { home, run: box(true).run });
    expect(doctor.findings).toContainEqual(note);
    expect(doctor.findings.map((finding) => finding.id)).not.toContain("secrets:not a pack");
    expect(doctor.ok).toBe(true);
  });

  const crew = (steps: PackManifest["steps"]) => withPack({ schema: 1, name: "crew", summary: "Crew.", steps });
  const gone = () => plan({ packs: [], workflows: {} }, devbox, [engine, team([step]), crew([{ ...step, id: "crew-box", run: ["crew-on"], check: ["crew-is-on"], undo: ["crew-off"] }])]);

  test("undoes a step that left before it applies the steps that stay, so a step that moved to another pack holds after one apply", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    await apply(planWith([step], {}), { home, run });
    const moved = plan({ packs: ["crew"], workflows: {} }, devbox, [engine, team([step]), crew([{ ...step, workflow: undefined }])]);
    const report = await apply(moved, { home, run });
    expect(report.ok).toBe(true);
    expect(world.on).toBe(true);
  });

  test("checks and undoes with the commands the step had when it last held, after its workflow goes off", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    await apply(planWith([step], {}), { home, run });
    await apply(planWith([{ ...step, check: ["broken"] }], { boxes: false }), { home, run });
    expect(world.on).toBe(false);
  });

  test("keeps each step as soon as it holds, so a step that stops the apply leaves the earlier ones to undo", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    const stops = async (command: string[]) => (command[0] === "stop" ? Promise.reject(new Error("stopped")) : run(command));
    await expect(apply(planWith([step, { id: "later", run: ["stop"] }], {}), { home, run: stops })).rejects.toThrow("stopped");
    await apply(gone(), { home, run });
    expect(world.on).toBe(false);
  });

  test("keeps a step that failed but holds what it set", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    const half = async (command: string[]) => (command.join(" ") === "box-on" ? ((world.on = true), 1) : run(command));
    expect((await apply(planWith([step], {}), { home, run: half })).findings).toContainEqual({ id: "step:auto-box", pack: "team", say: "Step auto-box of the team pack failed.", repair: "apply" });
    await apply(gone(), { home, run });
    expect(world.on).toBe(false);
  });

  test("keeps the steps of an apply that runs while another one does", async () => {
    const { world, run } = box(false);
    const other = { on: false };
    const home = temp.make("home-");
    const crewRun = async (command: string[]) => {
      const name = command.join(" ");
      if (name === "crew-is-on") return other.on ? 0 : 1;
      if (name === "crew-on") return (other.on = true), 0;
      if (name === "crew-off") return (other.on = false), 0;
      return run(command);
    };
    const crewPlan = plan({ packs: ["crew"], workflows: {} }, devbox, [engine, crew([{ ...step, id: "crew-box", workflow: undefined, run: ["crew-on"], check: ["crew-is-on"], undo: ["crew-off"] }])]);
    const meanwhile = async (command: string[]) => (command.join(" ") === "box-on" ? (await apply(crewPlan, { home, run: crewRun }), run(command)) : run(command));
    await apply(planWith([step], {}), { home, run: meanwhile });
    await apply(gone(), { home, run: crewRun });
    expect(world.on).toBe(false);
    expect(other.on).toBe(false);
  });

  test("refuses a step ledger that is a link, rather than run commands from another file", async () => {
    const home = temp.make("home-");
    const elsewhere = join(temp.make("elsewhere-"), "steps.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, steps: [] }));
    mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
    symlinkSync(elsewhere, join(home, ".local/state/fleet/steps.json"));
    await expect(apply(planWith([step], {}), { home, run: box(true).run })).rejects.toThrow(".local/state/fleet/steps.json must be a regular file");
  });

  test("needs an id no other step of the pack uses, once a step has an undo", async () => {
    await expect(loadPacks(team([step, { ...step, run: ["other"] }]).dir)).rejects.toThrow("steps auto-box: a step with an undo needs an id no other step of the pack uses");
    await loadPacks(team([{ id: "twin", run: ["on-linux"], on: ["linux"] }, { id: "twin", run: ["on-mac"], on: ["darwin"] }]).dir);
  });

  test("needs a check, so Fleet can tell what is left to undo", async () => {
    await expect(loadPacks(team([{ id: "auto-box", run: ["box-on"], undo: ["box-off"] }]).dir)).rejects.toThrow("steps auto-box: undo needs a check");
    await expect(loadPacks(team([{ ...step, check: [] }]).dir)).rejects.toThrow("steps auto-box: undo needs a check");
    await expect(loadPacks(team([{ ...step, undo: "box-off" as unknown as string[] }]).dir)).rejects.toThrow("steps auto-box: undo must be a command list");
  });
});
