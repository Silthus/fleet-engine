import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import type { AvailableSource, FetchedSource, MachineFile, MachineRole, PackManifest, Plan, Profile } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
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
