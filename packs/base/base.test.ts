import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadPacks } from "../../src/pack/manifest.ts";
import type { AiPlan, AvailableSource, MachineFile, Plan, Profile } from "../../src/pack/types.ts";
import { resolve } from "../../src/reconciler/resolve.ts";

const plans: AiPlan[] = ["claude", "codex", "both"];
const mac: MachineFile = { schema: 1, role: "mac" };
const devbox: MachineFile = { schema: 1, role: "devbox" };
let engine: AvailableSource;

beforeAll(async () => {
  const dir = join(import.meta.dir, "../..");
  engine = { ref: { name: "engine", repo: "Silthus/fleet-engine", ref: "main" }, dir, packs: await loadPacks(dir) };
});

function plan(ai: AiPlan, machine = mac, settings: Profile["settings"] = {}, sources = [engine]): Plan {
  const profile: Profile = { schema: 1, dir: "/profile", engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [], packs: sources.slice(1).flatMap((source) => source.packs.map((pack) => pack.manifest.name)), plan: ai, settings, workflows: {} };
  return resolve(profile, machine, sources);
}

function agents(result: Plan) {
  const file = result.files.find((item) => item.target === ".agents/AGENTS.md");
  if (!file || !("content" in file)) throw new Error("no AGENTS.md");
  return file.content;
}

describe("the Base pack", () => {
  test.each(plans)("gives a stable AGENTS.md for plan %s", (ai) => {
    expect(agents(plan(ai))).toMatchSnapshot();
    expect(agents(plan(ai, devbox))).toBe(agents(plan(ai)));
  });

  test("names only the models of the chosen plan", () => {
    expect(new Set(plan("claude").models.map((row) => row.provider))).toEqual(new Set(["claude"]));
    expect(new Set(plan("codex").models.map((row) => row.provider))).toEqual(new Set(["codex"]));
    expect(new Set(plan("both").models.map((row) => row.provider))).toEqual(new Set(["claude", "codex"]));
    for (const ai of plans) expect(plan(ai).models.map((row) => row.role)).toEqual(expect.arrayContaining(["lookup", "survey", "research", "implementation", "review"]));
  });

  test("asks nothing at setup and declares the settings the Base commands read", () => {
    for (const ai of plans) {
      const result = plan(ai, devbox);
      expect(result.unanswered).toEqual([]);
      expect(result.settings).toEqual({ "base.heavySlots": 2, "base.diskFloorGigabytes": 10, "identity.signer": "ssh" });
    }
  });

  test("signs with the Coder key in a Coder workspace and with an SSH key everywhere else", () => {
    const coder: MachineFile = { schema: 1, role: "devbox", coder: true };
    expect(plan("both", coder).settings["identity.signer"]).toBe("coder");
    expect(plan("both", devbox).settings["identity.signer"]).toBe("ssh");
    expect(plan("both", mac).settings["identity.signer"]).toBe("ssh");
    expect(plan("both", coder, { "identity.signer": "1password" }).settings["identity.signer"]).toBe("1password");
  });

  test("lets a pack override the signer default", () => {
    const signer = { key: "identity.signer", question: "Which key signs?", type: "choice" as const, choices: [{ value: "1password", label: "1Password" }], default: "1password", ask: "never" as const };
    const team: AvailableSource = { ref: { name: "team", repo: "team/packs", ref: "main" }, dir: "/team", packs: [{ manifest: { schema: 1, name: "team", summary: "Team rules.", settings: [signer] }, dir: "/team/packs/team" }] };
    const result = plan("both", { schema: 1, role: "devbox", coder: true }, {}, [engine, team]);
    expect(result.settings["identity.signer"]).toBe("1password");
    expect(result.ask.filter((setting) => setting.key === "identity.signer")).toEqual([]);
  });

  test("keeps Base's signer when a pack's override sits in a workflow that is off", () => {
    const signer = { key: "identity.signer", question: "Which key signs?", type: "choice" as const, choices: [{ value: "1password", label: "1Password" }], default: "1password", ask: "never" as const };
    const workflows = [{ id: "team-signing", name: "Team signing", sentence: "Signs with 1Password.", default: false, settings: ["identity.signer"] }];
    const team: AvailableSource = { ref: { name: "team", repo: "team/packs", ref: "main" }, dir: "/team", packs: [{ manifest: { schema: 1, name: "team", summary: "Team rules.", settings: [signer], workflows }, dir: "/team/packs/team" }] };
    const coder: MachineFile = { schema: 1, role: "devbox", coder: true };
    expect(plan("both", coder, {}, [engine, team]).settings["identity.signer"]).toBe("coder");
    expect(plan("both", coder, { "identity.signer": "ssh" }, [engine, team]).settings["identity.signer"]).toBe("ssh");
    const on = resolve({ schema: 1, dir: "/profile", engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [], packs: ["team"], plan: "both", settings: {}, workflows: { "team-signing": true } }, coder, [engine, team]);
    expect(on.settings["identity.signer"]).toBe("1password");
  });

  test("installs Codex hooks, Codex config, and the Codex CLI only when the plan has Codex", () => {
    const codex = (result: Plan) => result.config.filter((entry) => entry.provider === "codex").map((entry) => entry.key);
    expect(codex(plan("claude"))).toEqual([]);
    expect(codex(plan("codex"))).toEqual(["hooks.UserPromptSubmit", "hooks.PostToolUse", "model", "model_reasoning_effort"]);
    expect(plan("both", devbox).steps.map((step) => step.id)).toEqual(["claude-cli", "codex-cli"]);
    expect(plan("claude", devbox).steps.map((step) => step.id)).toEqual(["claude-cli"]);
    expect(plan("codex", devbox).steps.map((step) => step.id)).toEqual(["codex-cli"]);
  });

  test("installs the agent CLIs on a Mac too, Codex from its Homebrew cask, so a clean Mac without Node can sign in", () => {
    expect(plan("both").steps.map((step) => step.id)).toEqual(["claude-cli", "codex-cli-mac"]);
    expect(plan("claude").steps.map((step) => step.id)).toEqual(["claude-cli"]);
    expect(plan("codex").steps.map((step) => step.id)).toEqual(["codex-cli-mac"]);
    expect(plan("both").steps.find((step) => step.id === "codex-cli-mac")).toMatchObject({ run: ["brew", "install", "--cask", "codex"], check: ["codex", "--version"] });
  });

  test("installs Codex on Linux from its release package, which needs no Node", () => {
    const step = plan("both", devbox).steps.find((item) => item.id === "codex-cli");
    expect(step).toMatchObject({ run: ["fleet", "install-codex"], check: ["codex", "--version"] });
    expect(step?.run).not.toContain("@openai/codex");
    expect(plan("both", devbox).commands["install-codex"]?.path).toEndWith("packs/base/commands/install-codex.ts");
  });

  test("gives each plan one T3 default model from its own provider", () => {
    const model = (ai: AiPlan) => plan(ai).config.filter((entry) => entry.key === "defaultModelSelection").map((entry) => (entry.value as { instanceId: string }).instanceId);
    expect(model("claude")).toEqual(["claudeAgent"]);
    expect(model("codex")).toEqual(["codex"]);
    expect(model("both")).toEqual(["claudeAgent"]);
  });

  test("links hooks everywhere and the heavy slice only on a devbox", () => {
    const linked = (result: Plan) => result.files.filter((item) => item.target.startsWith(".config/")).map((item) => item.target);
    expect(linked(plan("both", devbox))).toContain(".config/systemd/user/fleet-heavy.slice");
    expect(linked(plan("both"))).not.toContain(".config/systemd/user/fleet-heavy.slice");
    expect(linked(plan("codex"))).not.toContain(".config/fleet/hooks/PreToolUse/name-a-model.ts");
    expect(linked(plan("claude"))).toEqual(expect.arrayContaining([".config/fleet/hooks/run.sh", ".config/fleet/hooks/PostToolUse/secret-guard.ts", ".config/fleet/hooks/PreToolUse/name-a-model.ts"]));
  });

  test("runs the update and prune jobs on every machine and keeps linked machines to devboxes", () => {
    for (const machine of [mac, devbox]) expect(plan("both", machine).jobs.map((job) => job.id)).toEqual(["fleet-update", "agent-update", "worktree-prune"]);
    expect(plan("both").workflows.find((workflow) => workflow.id === "linked-machines")).toMatchObject({ active: false, reason: "needs devbox" });
    expect(plan("both", devbox).config.some((entry) => entry.key === "linkedEnvironmentsEnabled")).toBe(true);
  });

  test("names no person, host, or private path in anything it writes", () => {
    for (const ai of plans) {
      const text = JSON.stringify(plan(ai, devbox)) + agents(plan(ai));
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(text).not.toMatch(/\/dev\/fleet\b|\.ts\.net|\bU0[A-Z0-9]{8,}\b/);
    }
  });
});
