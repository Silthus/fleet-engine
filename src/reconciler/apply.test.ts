import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
import { apply, check } from "./apply.ts";

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
    settings: {},
    unanswered: [],
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
});
