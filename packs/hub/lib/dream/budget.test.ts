import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../../src/testing/git.ts";
import { writeHome } from "../testing.ts";
import { dreamCommand, type DreamIo } from "./command.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const now = Date.parse("2026-11-05T04:10:00Z");
const settings = { "hub.alias": "my-hub", "memory.repo": "me/notes", "memory.subtree": "memory" };

function note(name: string, fields: Record<string, string> = {}, body = "A fact.") {
  const extra = Object.entries(fields).map(([key, value]) => `${key}: ${value}\n`).join("");
  return `---\nname: ${name}\ndescription: about ${name}\nmetadata:\n  type: project\n${extra}---\n${body}\n`;
}

function subtreeHome(files: Record<string, string>) {
  const home = temp.make("fleet-dream-budget-");
  const prefixed = Object.fromEntries(Object.entries(files).map(([path, text]) => [`.agents/memory-repo/memory/${path}`, text]));
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub" }), ".agents/memory-repo/README.md": "# Notes\n", ...prefixed });
  symlinkSync(join(home, ".agents/memory-repo/memory"), join(home, ".agents/memory"));
  return home;
}

function run(home: string, args: string[]) {
  const printed: string[] = [];
  const offline = () => { throw new Error("budget reaches no other machine"); };
  const dream: DreamIo = {
    home, env: { FLEET_SETTINGS: JSON.stringify(settings) }, self: "hub-host", now: () => now,
    print: (text) => void printed.push(text), say: (text) => void printed.push(text),
    peers: () => [], onPeer: offline, boxes: () => undefined, git: offline, analyst: offline, launch: offline,
  };
  return dreamCommand(["budget", ...args], dream).then((code) => ({ code, lines: printed.join("\n").split("\n") }));
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
    "projects/app/INDEX.md: 103 lines; the limit is 100",
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
