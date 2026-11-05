import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
import { apply, check, filesAdapter, type Adapter } from "./apply.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    machine: { schema: 1, role: "linux" },
    os: "linux",
    ai: "both",
    packs: [{ name: "base", source: "engine", ref: "main", available: true }],
    workflows: [],
    files: [{ target: ".agents/AGENTS.md", content: "rules\n" }],
    config: [],
    owners: {},
    jobs: [],
    human: [],
    steps: [],
    checks: [],
    commands: {},
    handlers: {},
    models: [],
    settings: {},
    unanswered: [],
    ask: [],
    dropped: [],
    ...overrides,
  };
}

const exitCodes = (codes: Record<string, number>) => async (command: string[]) => codes[command.join(" ")] ?? 0;

describe("apply", () => {
  test("refuses to write while a setting is unanswered", async () => {
    const home = temp.make("home-");
    const report = await apply(plan({ unanswered: [{ key: "orchestration.tracker", question: "Which repo holds your maps?", type: "string" }] }), { home });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({ id: "unanswered:orchestration.tracker", pack: "orchestration", say: "Which repo holds your maps? Answer it with fleet set orchestration.tracker=<value>.", repair: "human" });
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("keeps the last applied files while a pack's source is unreachable", async () => {
    const home = temp.make("home-");
    const team = { target: ".agents/skills/team", content: "team skill\n" };
    await apply(plan({ files: [plan().files[0]!, team] }), { home });
    const offline = plan({ packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] });
    const report = await apply(offline, { home });
    expect(readFileSync(join(home, ".agents/skills/team"), "utf8")).toBe("team skill\n");
    expect(report.findings).toContainEqual({ id: "pack:team", pack: "team", say: "The team pack is not applied: not found; unreachable sources: team" });
    expect((await apply(plan(), { home })).actions).toContainEqual({ target: ".agents/skills/team", operation: "remove" });
  });

  test("keeps skills whose source is unreachable, and shared files that would lose an unreachable pack's part", async () => {
    const home = temp.make("home-");
    const skill = temp.make("skill-");
    const rules = { target: ".agents/AGENTS.md", content: "rules\nteam rules\n" };
    const link = { target: ".agents/skills/team", source: skill };
    await apply(plan({ files: [rules, link] }), { home });
    rmSync(skill, { recursive: true });
    const offline = plan({
      packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }],
      dropped: [{ pack: "base", item: "skill team:review", reason: "its source is unreachable" }],
    });
    const report = await apply(offline, { home });
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toBe("rules\nteam rules\n");
    expect(lstatSync(join(home, ".agents/skills/team")).isSymbolicLink()).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({ id: "outage", say: expect.stringContaining("Left .agents/AGENTS.md, .agents/skills/team as they are") }));
    const back = await apply(plan(), { home });
    expect(back.actions).toContainEqual({ target: ".agents/AGENTS.md", operation: "replace" });
    expect(back.actions).toContainEqual({ target: ".agents/skills/team", operation: "remove" });
  });

  test("routes --adopt to the adapter that owns the target and rejects unknown targets", async () => {
    const home = temp.make("home-");
    const seen: string[][] = [];
    const config: Adapter = { name: "config", targets: () => [".claude/settings.json"], apply: async (_plan, context) => (seen.push(context.adopt), { actions: [], findings: [] }) };
    const report = await apply(plan(), { home, adopt: [".claude/settings.json"], adapters: [filesAdapter, config] });
    expect(report.ok).toBe(true);
    expect(seen).toEqual([[".claude/settings.json"]]);
    expect(apply(plan(), { home, adopt: [".bashrc"] })).rejects.toThrow("nothing to adopt at .bashrc");
  });

  test("marks only the failing pack when a pack step fails", async () => {
    const steps = [
      { id: "a", run: ["one"], pack: "hub" },
      { id: "b", run: ["two"], pack: "hub" },
      { id: "c", run: ["three"], pack: "posthog" },
    ];
    const ran: string[] = [];
    const report = await apply(plan({ steps }), { home: temp.make("home-"), run: async (command) => (ran.push(command[0]!), command[0] === "one" ? 1 : 0) });
    expect(ran).toEqual(["one", "three"]);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([{ id: "step:a", pack: "hub", say: "Step a of the hub pack failed.", repair: "apply" }]);
  });

  test("skips a step whose check already passes", async () => {
    const steps = [
      { id: "cli", run: ["install-cli"], check: ["cli-version"], pack: "base" },
      { id: "fresh", run: ["install-fresh"], check: ["fresh-version"], pack: "base" },
    ];
    const ran: string[] = [];
    const run = async (command: string[]) => (ran.push(command[0]!), command[0] === "fresh-version" ? 1 : 0);
    await apply(plan({ steps }), { home: temp.make("home-"), run });
    expect(ran).toEqual(["cli-version", "fresh-version", "install-fresh", "fresh-version"]);
  });

  test("reports a step whose run exits 0 but whose check still fails, and fails the apply", async () => {
    const steps = [
      { id: "codex-cli", run: ["install-codex"], check: ["codex", "--version"], pack: "base" },
      { id: "after", run: ["install-after"], pack: "base" },
    ];
    const ran: string[] = [];
    const report = await apply(plan({ steps }), { home: temp.make("home-"), run: async (command) => (ran.push(command[0]!), command[0] === "codex" ? 127 : 0) });
    expect(ran).toEqual(["codex", "install-codex", "codex"]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([{ id: "step:codex-cli", pack: "base", say: "Step codex-cli of the base pack ran, but does not pass its check.", repair: "apply" }]);
  });

  test("a step that waits for a sign-in runs only once its probe passes, and doctor does not report it", async () => {
    const human = [{ id: "coder", say: "Sign in to Coder", probe: ["coder", "whoami"], pack: "team" }];
    const steps = [{ id: "devbox", run: ["devbox-start"], check: ["devbox-status"], after: "coder", pack: "team" }];
    const ran: string[] = [];
    const signedOut = async (command: string[]) => (ran.push(command[0]!), 1);
    const report = await apply(plan({ human, steps }), { home: temp.make("home-"), run: signedOut });
    expect(ran).toEqual(["coder"]);
    expect(report.findings).toEqual([]);
    const doctor = await check(plan({ human, steps }), { home: temp.make("home-"), run: signedOut });
    expect(doctor.findings.map((finding) => finding.id).filter((id) => !id.startsWith("files:"))).toEqual(["human:coder"]);
    ran.length = 0;
    await apply(plan({ human, steps }), { home: temp.make("home-"), run: async (command) => (ran.push(command[0]!), command[0] === "devbox-status" ? 1 : 0) });
    expect(ran).toEqual(["coder", "devbox-status", "devbox-start", "devbox-status"]);
  });

  test("a sign-in is probed when its first waiting step comes up, after the steps before it ran", async () => {
    const human = [{ id: "coder", say: "Sign in to Coder", probe: ["coder", "whoami"], pack: "team" }];
    const steps = [
      { id: "install-coder", run: ["install-coder"], check: ["coder-installed"], pack: "team" },
      { id: "devbox", run: ["devbox-start"], after: "coder", pack: "team" },
    ];
    let installed = false;
    const ran: string[] = [];
    const run = async (command: string[]) => {
      ran.push(command[0]!);
      if (command[0] === "install-coder") installed = true;
      if (command[0] === "coder-installed") return installed ? 0 : 1;
      if (command[0] === "coder") return installed ? 0 : 127;
      return 0;
    };
    await apply(plan({ human, steps }), { home: temp.make("home-"), run });
    expect(ran).toEqual(["coder-installed", "install-coder", "coder-installed", "coder", "devbox-start"]);
  });

  test("runs steps with the plan's home directory as HOME", async () => {
    const home = temp.make("home-");
    const steps = [{ id: "mark", run: ["sh", "-c", 'touch "$HOME/marked"'], check: ["sh", "-c", 'test -f "$HOME/marked"'], pack: "base" }];
    const report = await apply(plan({ steps }), { home });
    expect(report.findings).toEqual([]);
    expect(existsSync(join(home, "marked"))).toBe(true);
  });
});

describe("check", () => {
  test("runs pack checks and human probes, and lists the human steps left", async () => {
    const human = [{ id: "github", say: "Sign in to GitHub.", command: "gh auth login --web", probe: ["gh", "auth", "status"], pack: "base" }];
    const checks = [{ id: "disk", run: ["df-check"], say: "Free some disk space.", pack: "base" }];
    const home = temp.make("home-");
    await apply(plan(), { home });
    const report = await check(plan({ human, checks }), { home, run: exitCodes({ "gh auth status": 1, "df-check": 0 }) });
    expect(report.ok).toBe(false);
    expect(report.humanLeft.map((step) => step.id)).toEqual(["github"]);
    expect(report.findings).toEqual([{ id: "human:github", pack: "base", say: "Sign in to GitHub. Run: gh auth login --web", repair: "human" }]);
  });

  test("runs each step's check", async () => {
    const steps = [{ id: "proxy", run: ["start-proxy"], check: ["proxy-health"], pack: "base" }];
    const home = temp.make("home-");
    await apply(plan(), { home });
    const report = await check(plan({ steps }), { home, run: exitCodes({ "proxy-health": 1 }) });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({ id: "step:proxy", pack: "base", say: "Step proxy of the base pack does not pass its check.", repair: "apply" });
  });

  test("fails while a kept file differs from the profile", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(join(home, ".agents/AGENTS.md"), "mine\n");
    const report = await check(plan(), { home, run: exitCodes({}) });
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.id)).toEqual(["kept:.agents/AGENTS.md"]);
  });
});

describe("a leading fleet in a pack's commands", () => {
  const launcher = ["/bin/sh", "/engine/fleet"];
  const team = {
    engineRoot: "/engine",
    files: [],
    human: [{ id: "login", pack: "team", say: "Sign in.", command: "fleet login", probe: ["fleet", "whoami"] }],
    steps: [{ id: "start", pack: "team", run: ["fleet", "start"], check: ["fleet", "status"], after: "login" }],
    checks: [{ id: "healthy", pack: "team", run: ["fleet", "health"], say: "Unhealthy." }],
  };
  const recorder = (codes: Record<string, number> = {}) => {
    const calls: string[] = [];
    return { calls, run: async (command: string[]) => (calls.push(command.join(" ")), codes[command.join(" ")] ?? 0) };
  };

  test("runs this engine's launcher in apply", async () => {
    const { calls, run } = recorder({ "/bin/sh /engine/fleet status": 1 });
    await apply(plan(team), { home: temp.make("home-"), run });
    expect(calls).toEqual([[...launcher, "whoami"], [...launcher, "status"], [...launcher, "start"], [...launcher, "status"]].map((command) => command.join(" ")));
  });

  test("runs this engine's launcher in check", async () => {
    const { calls, run } = recorder();
    await check(plan(team), { home: temp.make("home-"), run });
    expect(calls).toEqual([[...launcher, "health"], [...launcher, "whoami"], [...launcher, "status"], [...launcher, "whoami"]].map((command) => command.join(" ")));
  });

  test("leaves other commands and a plan without an engine as they are", async () => {
    const { calls, run } = recorder();
    await check(plan({ ...team, engineRoot: undefined, checks: [{ id: "gh", pack: "team", run: ["gh", "fleet"], say: "No gh." }] }), { home: temp.make("home-"), run });
    expect(calls).toEqual(["gh fleet", "fleet whoami", "fleet status", "fleet whoami"]);
  });
});
