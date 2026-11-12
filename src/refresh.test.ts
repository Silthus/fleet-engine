import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "./cli.ts";
import { filesAdapter } from "./reconciler/apply.ts";
import { repoRoot } from "./testing/cli.ts";
import { isolateGit, spawnGit, tempDirs } from "./testing/git.ts";
import { tryLock } from "./lock.ts";

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
  const clock = { at: Date.UTC(2026, 0, 1), naps: [] as number[], onSleep: () => {}, now: () => clock.at, sleep: async (ms: number) => (clock.naps.push(ms), clock.onSleep()) };
  const fleet = (...args: string[]) => main(args, { home, engineRoot: repoRoot, platform: "linux", env: {}, print: (line) => lines.push(line), run: async (command) => (steps.push(command), 0), adapters: () => [filesAdapter], clock });
  const code = await fleet("apply", "--profile", profile);
  if (code !== 0) throw new Error(lines.join("\n"));
  steps.length = 0;
  lines.length = 0;
  const read = (target: string) => readFileSync(join(home, target), "utf8");
  const cache = join(home, ".local/share/fleet/sources");
  return { repo, home, cache, clock, fleet, steps, lines, read };
}

const skill = ".agents/skills/review/SKILL.md";
const minutes = (count: number) => count * 60_000;

async function forcePushOrphan(repo: string) {
  await spawnGit(repo, "checkout", "-q", "--orphan", "rewrite");
  await commit(repo, "rewrite", { "packs/team/rules.md": "Rewritten.\n", "packs/team/AGENTS.md": "Rewritten.\n", "packs/team/skills/review/SKILL.md": "# review\n" });
  await spawnGit(repo, "branch", "-f", "main", "rewrite");
  await spawnGit(repo, "checkout", "-q", "main");
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

  test("keeps an edit to a linked skill when the branch did not move", async () => {
    const box = await machine();
    writeFileSync(join(box.home, skill), "# my review\n");

    expect(await box.fleet("refresh")).toBe(0);

    expect(box.read(skill)).toBe("# my review\n");
  });

  test("skips a moved source while a linked skill has an edit, and names the edited file", async () => {
    const box = await machine();
    writeFileSync(join(box.home, skill), "# my review\n");
    await v2(box.repo);

    expect(await box.fleet("refresh")).toBe(1);

    expect(box.read(skill)).toBe("# my review\n");
    expect(box.read(guide)).toBe("Rules v1.\n");
    expect(box.lines.join("\n")).toContain("packs/team/skills/review/SKILL.md");
  });

  test("keeps a new file in a linked skill folder that the moved branch also adds", async () => {
    const box = await machine();
    writeFileSync(join(box.home, ".agents/skills/review/notes.md"), "Mine.\n");
    await commit(box.repo, "v2", { "packs/team/skills/review/notes.md": "Theirs.\n" });

    expect(await box.fleet("refresh")).toBe(1);

    expect(box.read(".agents/skills/review/notes.md")).toBe("Mine.\n");
  });

  test("fleet apply keeps an edit to a linked skill when the branch moved", async () => {
    const box = await machine();
    writeFileSync(join(box.home, skill), "# my review\n");
    await v2(box.repo);

    await box.fleet("apply");

    expect(box.read(skill)).toBe("# my review\n");
    expect(box.lines.join("\n")).toContain("packs/team/skills/review/SKILL.md");
  });

  test("refuses a force-push that does not build on the applied commit", async () => {
    const box = await machine();
    await forcePushOrphan(box.repo);

    expect(await box.fleet("refresh")).toBe(1);

    expect(box.read(guide)).toBe("Rules v1.\n");
    expect(box.lines.join("\n")).toContain("does not build on");
  });

  test("runs although the lock file names a live process that holds no lock", async () => {
    const box = await machine();
    await v2(box.repo);
    mkdirSync(join(box.home, ".local/state/fleet"), { recursive: true });
    writeFileSync(join(box.home, ".local/state/fleet/refresh.lock"), String(process.pid));

    expect(await box.fleet("refresh")).toBe(0);

    expect(box.read(guide)).toBe("Rules v2.\n");
  });

  test("stops while another refresh holds the lock, and reports a lock held for over 30 minutes", async () => {
    const box = await machine();
    await v2(box.repo);
    const held = tryLock(join(box.home, ".local/state/fleet/refresh.lock"), box.clock.at)!;
    try {
      expect(await box.fleet("refresh")).toBe(0);
      expect(box.read(guide)).toBe("Rules v1.\n");

      box.clock.at += minutes(31);
      expect(await box.fleet("refresh")).toBe(1);
      expect(box.lines.at(-1)).toContain("31 minutes");
    } finally {
      held.release();
    }
  });

  test("skips a source whose cache another Fleet run works in", async () => {
    const box = await machine();
    await v2(box.repo);
    const held = tryLock(join(box.cache, "team.lock"), box.clock.at)!;
    try {
      expect(await box.fleet("refresh")).toBe(0);
      expect(box.read(guide)).toBe("Rules v1.\n");
    } finally {
      held.release();
    }

    expect(await box.fleet("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");
  });

  test("fleet apply waits for a source's cache lock", async () => {
    const box = await machine();
    await v2(box.repo);
    const held = tryLock(join(box.cache, "team.lock"), box.clock.at)!;
    box.clock.onSleep = () => held.release();

    expect(await box.fleet("apply")).toBe(0);

    expect(box.clock.naps.length).toBeGreaterThan(0);
    expect(box.read(guide)).toBe("Rules v2.\n");
  });

  test("prints a failed fetch and skips that source for 30 minutes", async () => {
    const box = await machine();
    renameSync(box.repo, `${box.repo}.away`);

    expect(await box.fleet("refresh")).toBe(1);
    expect(box.lines.join("\n")).toContain("could not reach");

    renameSync(`${box.repo}.away`, box.repo);
    await v2(box.repo);
    box.clock.at += minutes(29);
    expect(await box.fleet("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v1.\n");

    box.clock.at += minutes(2);
    expect(await box.fleet("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");
  });
});
