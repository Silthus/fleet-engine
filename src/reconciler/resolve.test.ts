import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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

function withPack(manifest: PackManifest, files: Record<string, string> = {}): FetchedSource {
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
