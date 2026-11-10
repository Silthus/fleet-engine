import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../../src/testing/git.ts";
import { writeHome } from "../testing.ts";
import { dreamCommand } from "./command.ts";
import { dreamSettings, hubWithSubtree, note, quietIo } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function subtreeHome(files: Record<string, string>) {
  const home = temp.make("fleet-dream-budget-");
  hubWithSubtree(home, files);
  return home;
}

async function run(home: string, args: string[], extra: Record<string, string> = {}) {
  const { io, printed } = quietIo(home, { env: { FLEET_SETTINGS: JSON.stringify({ ...dreamSettings, ...extra }) } });
  const code = await dreamCommand(["budget", ...args], io);
  return { code, lines: printed.join("\n").split("\n") };
}

const fresh = { modified: "2026-11-01" };

test("budget checks the one memory root of the subtree layout: repo indexes, triggers, status age, wiki links, stale repo paths and kept conflicts", async () => {
  const repoIndexLines = Array.from({ length: 100 }, (_, index) => `- line ${index}`).join("\n");
  const home = subtreeHome({
    "MEMORY.md": "# Memory index\n- [Good](good.md) — fine\n- [Links](links.md) — wiki\n- [Short](short.md) — trigger\n- [Odd](odd.md) — status\n- [Old](old.md) — unconfirmed\n",
    "good.md": note("good", { ...fresh, status: "confirmed", triggers: "[fleet proof]" }, "See [[links]]."),
    "links.md": note("links", fresh, "See [[good]] and [[gone]]."),
    "short.md": note("short", { ...fresh, triggers: "[gh, fleet apply]" }),
    "odd.md": note("odd", { ...fresh, status: "maybe" }),
    "old.md": note("old", { modified: "2026-10-01", status: "unconfirmed" }),
    "projects/app/INDEX.md": `# app\n- [Paths](paths.md) — paths\n${repoIndexLines}\n`,
    "projects/app/paths.md": note("paths", fresh, "Edit `src/main.ts` and `src/gone.ts`, not `vendor/lib.ts`."),
    ".conflicts/paths.md.abc.20261104.devbox-1.lost": "the other side\n",
  });
  writeHome(home, { "dev/app/src/main.ts": "export {};\n" });
  mkdirSync(join(home, "dev/app/.git"), { recursive: true });

  const { code, lines } = await run(home, []);

  expect(code).toBe(1);
  expect(lines.sort()).toEqual([
    ".conflicts/paths.md.abc.20261104.devbox-1.lost: a sync conflict replaced this version; merge what it has that the memory lacks, then delete it",
    "links.md: links [[gone]], which no memory is; repoint it, write that memory, or drop the link",
    "odd.md: status maybe; use confirmed or unconfirmed",
    "old.md: unconfirmed since 2026-10-01; confirm it against a session or the code, or delete it",
    "projects/app/INDEX.md: 102 lines; the limit is 100",
    "projects/app/paths.md: names `src/gone.ts`, which the hub's app checkout lacks; check it, then fix or delete the memory",
    'short.md: trigger "gh" is shorter than 4 characters and never fires; name the command or tool',
  ]);
});

test("budget checks a repo index's size against the repo limit, and the main index against its own", async () => {
  const long = `- ${"x".repeat(200)}`;
  const home = subtreeHome({
    "MEMORY.md": `# Memory index\n${Array.from({ length: 60 }, () => long).join("\n")}\n`,
    "projects/app/INDEX.md": `# app\n${Array.from({ length: 60 }, () => long).join("\n")}\n`,
  });

  const { code, lines } = await run(home, ["--json"]);

  expect(code).toBe(1);
  expect(JSON.parse(lines.join("\n"))).toEqual([
    { file: "projects/app/INDEX.md", problem: "12186 bytes; the limit is 12000. Shorten its lines or move notes into topic notes" },
  ]);
});

test("budget skips path checks for a repo the hub has no checkout of, and finds a checkout in the home folder", async () => {
  const home = subtreeHome({
    "MEMORY.md": "# Memory index\n",
    "projects/app/INDEX.md": "# app\n- [Paths](paths.md) — paths\n",
    "projects/app/paths.md": note("paths", fresh, "Edit `src/gone.ts`."),
    "projects/web/INDEX.md": "# web\n- [Paths](paths.md) — paths\n",
    "projects/web/paths.md": note("paths", fresh, "Edit `src/gone.ts`."),
  });
  mkdirSync(join(home, "web/.git"), { recursive: true });
  mkdirSync(join(home, "web/src"), { recursive: true });

  const { code, lines } = await run(home, []);

  expect(code).toBe(1);
  expect(lines).toEqual(["projects/web/paths.md: names `src/gone.ts`, which the hub's web checkout lacks; check it, then fix or delete the memory"]);
});

test("budget given a dream worktree of the whole memory repo checks its memory.subtree folder", async () => {
  const home = subtreeHome({ "MEMORY.md": "# Memory index\n", "stray.md": note("stray", fresh) });
  const worktree = join(home, ".local/state/fleet/dream/2026-11-05/memory");
  writeHome(home, { ".local/state/fleet/dream/2026-11-05/memory/memory/MEMORY.md": "# Memory index\n- [Kept](kept.md) — kept\n", ".local/state/fleet/dream/2026-11-05/memory/memory/kept.md": note("kept", fresh), ".local/state/fleet/dream/2026-11-05/memory/memory/loose.md": note("loose", fresh) });

  expect(await run(home, [])).toEqual({ code: 1, lines: ["stray.md: no index links it"] });
  expect(await run(home, [worktree])).toEqual({ code: 1, lines: ["loose.md: no index links it"] });
});

test("budget reads frontmatter as YAML: quoted values, comments, and keys under metadata, but not text inside a description", async () => {
  const home = subtreeHome({
    "MEMORY.md": "# Memory index\n- [Quoted](quoted.md) — q\n- [Commented](commented.md) — c\n- [Folded](folded.md) — f\n",
    "quoted.md": "---\nname: quoted\ndescription: q\nmetadata:\n  type: user\n  status: 'confirmed'\nmodified: \"2026-11-01\"\n---\nA fact.\n",
    "commented.md": "---\nname: commented\ndescription: c\nmetadata:\n  type: user\n  status: unconfirmed # checked later\n  modified: 2026-11-01\n---\nA fact.\n",
    "folded.md": "---\nname: folded\ndescription: >-\n  status: maybe\nmetadata:\n  type: user\nmodified: 2026-11-01\n---\nA fact.\n",
  });

  expect(await run(home, [])).toEqual({ code: 0, lines: ["Memory is within budget."] });
});

test("budget accepts a wiki link by path or with .md, and a ./ path whose first folder the checkout lacks", async () => {
  const home = subtreeHome({
    "MEMORY.md": "# Memory index\n- [Other](tech/cli/other.md) — o\n",
    "tech/cli/other.md": note("other", fresh),
    "projects/app/INDEX.md": "# app\n- [Links](links.md) — l\n",
    "projects/app/links.md": note("links", fresh, "See [[tech/cli/other]], [[other.md]] and `./vendor/missing.ts`."),
  });
  mkdirSync(join(home, "dev/app/.git"), { recursive: true });

  expect(await run(home, [])).toEqual({ code: 0, lines: ["Memory is within budget."] });
});

test("budget counts lines as the memory cap does: a repo index of exactly 100 lines passes, 101 fails", async () => {
  const lines = (count: number) => `${Array.from({ length: count }, (_, index) => `- line ${index}`).join("\n")}\n`;
  const home = subtreeHome({ "MEMORY.md": "# Memory index\n", "projects/app/INDEX.md": lines(100), "projects/web/INDEX.md": lines(101) });

  expect(await run(home, [])).toEqual({ code: 1, lines: ["projects/web/INDEX.md: 101 lines; the limit is 100"] });
});

test("budget never leaves the folder it was given for a memory.subtree that climbs out of it", async () => {
  const home = subtreeHome({ "MEMORY.md": "# Memory index\n" });
  const worktree = join(home, "run/memory");
  writeHome(home, { "run/memory/README.md": "# Notes\n", "run/sibling/MEMORY.md": "# Memory index\n", "run/sibling/stray.md": note("stray", fresh) });

  expect(await run(home, [worktree], { "memory.subtree": "../sibling" })).toEqual({ code: 1, lines: ["MEMORY.md: missing"] });
});
