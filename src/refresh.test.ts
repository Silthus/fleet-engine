import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "./cli.ts";
import { filesAdapter } from "./reconciler/apply.ts";
import { repoRoot } from "./testing/cli.ts";
import { isolateGit, spawnGit, tempDirs } from "./testing/git.ts";
import { devbox, engineSource, resolveEngine } from "./testing/packs.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const guide = ".agents/guides/team-rules.md";

async function teamRepo() {
  const repo = join(temp.make("team-"), "team.git");
  mkdirSync(repo);
  await spawnGit(repo, "init", "-q", "-b", "main");
  await commit(repo, "v1", { "packs/team/rules.md": "Rules v1.\n", "packs/team/AGENTS.md": "Team v1.\n", "packs/team/skills/review/SKILL.md": "# review\n" });
  await spawnGit(repo, "tag", "v1");
  return repo;
}

async function commit(repo: string, message: string, files: Record<string, string>, skills = ["skills/review"]) {
  const manifest = { schema: 1, name: "team", summary: "Team rules.", instructions: "AGENTS.md", guides: [{ guide: "team-rules", path: "rules.md" }], skills };
  for (const [path, text] of Object.entries({ "packs/team/pack.json": JSON.stringify(manifest), ...files })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  await spawnGit(repo, "add", ".");
  await spawnGit(repo, "commit", "-q", "-m", message);
}

const v2 = (repo: string) => commit(repo, "v2", { "packs/team/rules.md": "Rules v2.\n", "packs/team/AGENTS.md": "Team v2.\n", "packs/team/skills/plan/SKILL.md": "# plan\n" }, ["skills/review", "skills/plan"]);

async function machine(ref = "main") {
  const repo = await teamRepo();
  const home = temp.make("home-");
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [{ name: "team", repo, ref }], packs: ["team"], plan: "both", settings: {}, workflows: {} }));
  const steps: string[][] = [];
  const lines: string[] = [];
  const fleet = (...args: string[]) => main(args, { home, engineRoot: repoRoot, platform: "linux", env: {}, print: (line) => lines.push(line), run: async (command) => (steps.push(command), 0), adapters: () => [filesAdapter] });
  const code = await fleet("apply", "--profile", profile);
  if (code !== 0) throw new Error(lines.join("\n"));
  steps.length = 0;
  const read = (target: string) => readFileSync(join(home, target), "utf8");
  return { repo, home, fleet, steps, lines, read };
}

describe("fleet refresh", () => {
  test("brings a moved branch's guide, instructions, and skills, keeps local edits and unmanaged files, and runs no step", async () => {
    const box = await machine();
    writeFileSync(join(box.home, ".codex/AGENTS.md"), "My own edit.\n");
    mkdirSync(join(box.home, ".claude/skills/plan"), { recursive: true });
    writeFileSync(join(box.home, ".claude/skills/plan/SKILL.md"), "# my plan\n");
    writeFileSync(join(box.home, "notes.md"), "Mine.\n");
    await v2(box.repo);

    expect(await box.fleet("refresh")).toBe(0);

    expect(box.read(guide)).toBe("Rules v2.\n");
    expect(box.read(".agents/AGENTS.md")).toContain("Team v2.");
    expect(box.read(".agents/skills/plan/SKILL.md")).toBe("# plan\n");
    expect(box.read(".codex/AGENTS.md")).toBe("My own edit.\n");
    expect(lstatSync(join(box.home, ".claude/skills/plan")).isSymbolicLink()).toBe(false);
    expect(box.read(".claude/skills/plan/SKILL.md")).toBe("# my plan\n");
    expect(box.read("notes.md")).toBe("Mine.\n");
    expect(box.steps).toEqual([]);
  });

  test("applies nothing when no branch moved", async () => {
    const box = await machine();
    rmSync(join(box.home, guide));

    expect(await box.fleet("refresh")).toBe(0);

    expect(existsSync(join(box.home, guide))).toBe(false);
  });

  test("leaves a source pinned to a tag alone, even when the tag moves", async () => {
    const box = await machine("v1");
    await v2(box.repo);
    await spawnGit(box.repo, "tag", "-f", "v1");

    expect(await box.fleet("refresh")).toBe(0);

    expect(box.read(guide)).toBe("Rules v1.\n");
  });

  test("stops while another refresh runs, and takes over the lock of one that died", async () => {
    const box = await machine();
    await v2(box.repo);
    const lock = join(box.home, ".local/state/fleet/refresh.lock");
    writeFileSync(lock, String(process.pid));

    expect(await box.fleet("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v1.\n");

    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(lock, String(dead.pid));

    expect(await box.fleet("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");
    expect(existsSync(lock)).toBe(false);
  });

  test("waits for another Fleet operation's lock and applies at the next run, though nothing new arrives", async () => {
    const box = await machine();
    await v2(box.repo);
    const fleetLock = join(box.home, ".local/state/fleet/lock");
    mkdirSync(fleetLock);

    expect(await box.fleet("refresh")).toBe(1);
    expect(box.read(guide)).toBe("Rules v1.\n");

    rmSync(fleetLock, { recursive: true });
    expect(await box.fleet("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");
  });

  test("runs every five minutes on each machine by default, and runs only fleet refresh", async () => {
    const plan = resolveEngine([await engineSource()], {}, devbox);
    const job = plan.jobs.find((item) => item.id === "source-refresh");
    expect(job).toMatchObject({ pack: "base", command: ["fleet", "refresh"], schedule: { every: "5m" } });
  });
});
