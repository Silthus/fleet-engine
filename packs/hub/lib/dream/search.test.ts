import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../../src/testing/git.ts";
import { writeHome } from "../testing.ts";
import { dreamCommand } from "./command.ts";
import type { Digest } from "./digest.ts";
import { dreamNow, hubWithSubtree, quietIo } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const state = ".local/state/fleet/dream";
const day = 86_400_000;

function digest(session: string, endedAt: string, texts: string[], fields: Partial<Digest> = {}): Digest {
  return {
    machine: "devbox-1", provider: "claude", session, cwd: "/home/me/dev/app", repo: "app", model: "m", startedAt: endedAt, endedAt,
    toolCalls: 1, skills: [], memoryReads: [], memoryWrites: [], tokens: 10,
    entries: texts.map((text, index) => ({ at: endedAt, role: index % 2 ? "assistant" as const : "user" as const, text })),
    ...fields,
  };
}

function hubWithRuns() {
  const home = temp.make("fleet-dream-search-");
  hubWithSubtree(home, { "MEMORY.md": "# Memory index\n" });
  writeHome(home, {
    [`${state}/2026-11-04/digests/a.json`]: JSON.stringify(digest("s-new", "2026-11-04T09:00:00Z", ["When do we deploy?", "We deploy on Tuesday after the freeze."])),
    [`${state}/2026-10-20/digests/b.json`]: JSON.stringify(digest("s-old", "2026-10-20T09:00:00Z", ["Deploy the web app on Tuesday."], { repo: "web", machine: "devbox-2" })),
    [`${state}/2026-10-20/digests/c.json`]: JSON.stringify(digest("s-other", "2026-10-20T08:00:00Z", ["Deploy on Friday."])),
    [`${state}/inbox/box-a-1.jsonl`]: `${JSON.stringify(digest("s-box", "2026-11-03T09:00:00Z", ["Box says deploy Tuesday."], { machine: "box-a" }))}\n`,
  });
  return home;
}

test("search on the hub lists the sessions of the last 30 days that name every word, newest first, with the lines that name them", async () => {
  const home = hubWithRuns();
  const { io, printed } = quietIo(home);

  expect(await dreamCommand(["search", "deploy", "TUESDAY"], io)).toBe(0);

  expect(printed.join("")).toBe([
    "2026-11-04T09:00 devbox-1 claude s-new (app)",
    "  [user] When do we deploy?",
    "  [assistant] We deploy on Tuesday after the freeze.",
    "",
    "2026-11-03T09:00 box-a claude s-box (app)",
    "  [user] Box says deploy Tuesday.",
    "",
    "2026-10-20T09:00 devbox-2 claude s-old (web)",
    "  [user] Deploy the web app on Tuesday.",
    "",
  ].join("\n"));
});

test("search says when nothing matches", async () => {
  const home = hubWithRuns();
  const { io, printed } = quietIo(home);

  expect(await dreamCommand(["search", "tuesday", "wednesday"], io)).toBe(0);

  const [none] = printed;
  expect(none).toBe('No session in the last 30 days names "tuesday" and "wednesday".\n');
});

test("search away from the hub asks the hub over SSH and passes on its answer and exit code", async () => {
  const home = temp.make("fleet-dream-search-");
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "devbox" }) });
  const asked: string[] = [];
  const { io, printed } = quietIo(home, { onPeer: async (alias, command) => (asked.push(`${alias}: ${command}`), { code: 0, stdout: "2026-11-04T09:00 hub claude s-1 (app)\n", stderr: "" }) });

  expect(await dreamCommand(["search", "it's", "deploy"], io)).toBe(0);

  expect(asked).toEqual([`my-hub: sh "$HOME/.local/share/fleet/engine/fleet" dream search 'it'\\''s' 'deploy'`]);
  expect(printed).toEqual(["2026-11-04T09:00 hub claude s-1 (app)\n"]);
});

test("search with no word prints its usage and exits 2", async () => {
  const { io, said } = quietIo(hubWithRuns());

  expect(await dreamCommand(["search"], io)).toBe(2);

  expect(said).toEqual(["Usage: fleet dream search <word>..."]);
});

test("the hub keeps runs and box digests for 30 days, then drops them", async () => {
  const home = hubWithRuns();
  const aged = (path: string, days: number) => utimesSync(path, new Date(dreamNow - days * day), new Date(dreamNow - days * day));
  mkdirSync(join(home, state, "2026-10-01"), { recursive: true });
  writeHome(home, { [`${state}/inbox/box-b-1.jsonl`]: "", [`${state}/inbox/box-c-1.jsonl`]: "" });
  aged(join(home, state, "inbox/box-b-1.jsonl"), 20);
  aged(join(home, state, "inbox/box-c-1.jsonl"), 31);
  const { io } = quietIo(home, { git: async () => ({ code: 0, stdout: "", stderr: "" }) });

  expect(await dreamCommand(["collect"], io)).toBe(0);

  expect([existsSync(join(home, state, "2026-10-20")), existsSync(join(home, state, "2026-10-01"))]).toEqual([true, false]);
  expect([existsSync(join(home, state, "inbox/box-b-1.jsonl")), existsSync(join(home, state, "inbox/box-c-1.jsonl"))]).toEqual([true, false]);
});

test("search hides credentials that an older box left in the inbox", async () => {
  const home = hubWithRuns();
  writeHome(home, { [`${state}/inbox/box-old-1.jsonl`]: `${JSON.stringify(digest("s-leak", "2026-11-04T10:00:00Z", ["deploy password=pretend-value123"], { machine: "box-old" }))}\n` });
  const { io, printed } = quietIo(home);

  expect(await dreamCommand(["search", "deploy"], io)).toBe(0);

  expect(printed.join("\n")).toContain("s-leak");
  expect(printed.join("\n")).not.toContain("pretend-value123");
});
