import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { git, gitEnv, tempDirs } from "../../../../src/testing/git.ts";
import { writeHome } from "../testing.ts";
import { AnalystFailure } from "./analyze.ts";
import type { Verdict } from "./audit.ts";
import { dreamCommand } from "./command.ts";
import type { Digest } from "./digest.ts";
import { dreamNow, note, quietIo, realGit } from "./testing.ts";

const temp = tempDirs();
afterAll(() => temp.cleanup());

function commitAt(dir: string, at: string, message: string, files: Record<string, string | null>) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, path));
    else writeHome(dir, { [path]: text });
  }
  const dated = { ...gitEnv, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  Bun.spawnSync(["git", "add", "-A"], { cwd: dir, env: dated });
  const answer = Bun.spawnSync(["git", "commit", "-q", "-m", message], { cwd: dir, env: dated });
  if (answer.exitCode !== 0) throw new Error(answer.stderr.toString());
  git(dir, "push", "-q", "origin", "HEAD:main");
}

function digest(fields: Partial<Digest>): Digest {
  return {
    machine: "devbox-1", provider: "claude", session: "s-1", cwd: "/home/me/dev/app", repo: "app", model: "m", startedAt: "2026-11-04T10:00:00Z",
    endedAt: "2026-11-04T11:00:00Z", toolCalls: 1, skills: [], memoryReads: [], memoryWrites: [], tokens: 10,
    entries: [{ at: "2026-11-04T10:00:00Z", role: "user", text: "Note the trap." }],
    ...fields,
  };
}

function hubWithSyncedNotes(firstAt = "2026-11-03T10:00:00Z") {
  const home = temp.make("fleet-dream-audit-");
  const origin = join(home, "origin.git");
  const writer = join(home, "writer");
  git(home, "init", "-q", "--bare", "-b", "main", origin);
  git(home, "clone", "-q", origin, writer);
  commitAt(writer, firstAt, "memory: devbox-1", {
    "README.md": "# Notes\n",
    "memory/MEMORY.md": "# Memory index\n",
    "memory/tech/old-read.md": note("old-read", { modified: "2026-09-01" }),
  });
  git(home, "clone", "-q", origin, join(home, ".agents/memory-repo"));
  symlinkSync(join(home, ".agents/memory-repo/memory"), join(home, ".agents/memory"));
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub" }) });
  commitAt(writer, "2026-11-04T12:00:00Z", "memory: devbox-1", {
    "memory/tech/trap.md": note("trap", {}, "Always run the slow suite twice."),
    "memory/projects/app/rule.md": note("rule", { originSessionId: "s-2" }, "Deploy on Tuesdays."),
    "memory/projects/app/lone.md": note("lone", {}, "A note from a Mac session."),
    "memory/tech/gone.md": note("gone"),
    "README.md": "# Notes, renamed\n",
  });
  commitAt(writer, "2026-11-04T13:00:00Z", "memory: devbox-2", { "memory/tech/gone.md": null });
  commitAt(writer, "2026-11-04T14:00:00Z", "Condense: dreamed", { "memory/tech/dreamed.md": note("dreamed") });
  const state = ".local/state/fleet/dream";
  writeHome(home, {
    [`${state}/2026-11-05/digests/s-1.json`]: JSON.stringify(digest({ memoryWrites: ["tech/trap.md"], memoryShown: ["tech/old-read.md"] })),
    [`${state}/2026-11-05/findings/s-1.json`]: JSON.stringify({ taskType: "fix", findings: [] }),
    [`${state}/2026-11-03/digests/s-2.json`]: JSON.stringify(digest({ machine: "devbox-2", session: "s-2", memoryReads: ["tech/old-read.md"], entries: [{ at: "2026-11-03T09:00:00Z", role: "user", text: "We deploy on Tuesdays." }] })),
    [`${state}/2026-11-03/findings/s-2.json`]: JSON.stringify({ taskType: "ops", findings: [] }),
  });
  return { home, run: join(home, state, "2026-11-05") };
}

const fine: Verdict = { verdict: "confirmed", reason: "Fine.", evidence: "", correction: "" };

function checker() {
  const asked: string[] = [];
  const verdicts: Record<string, Verdict> = {
    "tech/trap.md": { verdict: "wrong", reason: "The session ran the suite once.", evidence: "ran once, passed", correction: "Run the slow suite once." },
    "projects/app/rule.md": { verdict: "confirmed", reason: "The person said so.", evidence: "We deploy on Tuesdays.", correction: "" },
  };
  return { asked, check: async (input: string) => (asked.push(input), verdicts[/^Memory: (.+)$/m.exec(input)![1]!] ?? fine) };
}

test.concurrent("audit checks each note that the sync changed since the last audit against the session that wrote it, and writes audit.md", async () => {
  const { home, run } = hubWithSyncedNotes();
  const { asked, check } = checker();
  const { io, printed } = quietIo(home, { git: realGit, checker: () => check });

  expect(await dreamCommand(["audit"], io)).toBe(0);

  expect(printed).toEqual([run]);
  const base = git(join(home, "writer"), "rev-list", "-1", "--before=2026-11-04T04:10:00Z", "main").slice(0, 12);
  expect(readFileSync(join(run, "audit.md"), "utf8")).toBe([
    "# Write audit 2026-11-05",
    "",
    `3 notes changed by sessions since ${base}; 3 checked.`,
    "",
    "## wrong (1)",
    "",
    "- `tech/trap.md`: The session ran the suite once.",
    "  Evidence: ran once, passed",
    "  Correction: Run the slow suite once.",
    "  Session: devbox-1 claude s-1",
    "",
    "## no session (1)",
    "",
    "- `projects/app/lone.md`: No digest of the writing session is on the hub: a Mac session, or one older than the runs.",
    "",
    "## confirmed (1)",
    "",
    "- `projects/app/rule.md`: The person said so.",
    "  Evidence: We deploy on Tuesdays.",
    "  Session: devbox-2 claude s-2",
    "",
    "## Recheck",
    "",
    "The most-read notes that nobody wrote or verified for 30 days. Check each against the code or the machines.",
    "- `tech/old-read.md`: read or shown in 2 sessions",
  ].join("\n"));
  expect(asked).toHaveLength(2);
  expect(asked.find((input) => input.includes("Memory: tech/trap.md"))).toContain("Always run the slow suite twice.");
  expect(asked.find((input) => input.includes("Memory: tech/trap.md"))).toContain("[user] Note the trap.");
  expect(asked.find((input) => input.includes("Memory: projects/app/rule.md"))).toContain("[user] We deploy on Tuesdays.");
});

test.concurrent("a second audit checks only what the sync changed after the first", async () => {
  const { home, run } = hubWithSyncedNotes();
  const first = checker();
  expect(await dreamCommand(["audit"], quietIo(home, { git: realGit, checker: () => first.check }).io)).toBe(0);
  commitAt(join(home, "writer"), "2026-11-05T02:00:00Z", "memory: devbox-1", { "memory/tech/trap.md": note("trap", {}, "Run the slow suite once.") });
  const second = checker();

  expect(await dreamCommand(["audit", run], quietIo(home, { git: realGit, checker: () => second.check }).io)).toBe(0);

  expect(second.asked).toHaveLength(1);
  expect(second.asked[0]).toContain("Memory: tech/trap.md");
  expect(second.asked[0]).toContain("+Run the slow suite once.");
  expect(readFileSync(join(run, "audit.md"), "utf8")).toContain("; 1 checked.");
});

test.concurrent("audit lists a check that failed, and checks it again next time", async () => {
  const { home, run } = hubWithSyncedNotes();
  const failing = async (input: string) => {
    if (input.includes("Memory: tech/trap.md")) throw new AnalystFailure("exit 2");
    return { verdict: "confirmed" as const, reason: "Fine.", evidence: "", correction: "" };
  };
  expect(await dreamCommand(["audit"], quietIo(home, { git: realGit, checker: () => failing }).io)).toBe(0);
  expect(readFileSync(join(run, "audit.md"), "utf8")).toContain("Checks failed on:\n- tech/trap.md: exit 2");
  const again = checker();

  expect(await dreamCommand(["audit"], quietIo(home, { git: realGit, checker: () => again.check }).io)).toBe(0);

  expect(again.asked.some((input) => input.includes("Memory: tech/trap.md"))).toBe(true);
});

test.concurrent("audit exits 1 and writes no audit when the memory checkout cannot fetch", async () => {
  const { home, run } = hubWithSyncedNotes();
  rmSync(join(home, "origin.git"), { recursive: true });
  const { io, said } = quietIo(home, { git: realGit, checker: () => checker().check });

  expect(await dreamCommand(["audit"], io)).toBe(1);

  expect(said.at(-1)).toStartWith("Fleet dream: audit failed: cannot fetch the memory repo");
  expect(existsSync(join(run, "audit.md"))).toBe(false);
});

test.concurrent("prepare collects, analyzes, then audits, and prints the run", async () => {
  const { home, run } = hubWithSyncedNotes();
  const { check } = checker();
  const analyst = async () => ({ taskType: "fix", findings: [] });
  const { io, printed } = quietIo(home, { git: realGit, checker: () => check, analyst: () => analyst });

  expect(await dreamCommand(["prepare"], io)).toBe(0);

  expect(printed).toEqual([run]);
  expect(readFileSync(join(run, "audit.md"), "utf8")).toContain("3 notes changed by sessions since");
});

test.concurrent("prepare still prints the run when the audit fails, and says why", async () => {
  const { home, run } = hubWithSyncedNotes();
  rmSync(join(home, "origin.git"), { recursive: true });
  const analyst = async () => ({ taskType: "fix", findings: [] });
  const { io, printed, said } = quietIo(home, { git: realGit, checker: () => checker().check, analyst: () => analyst });

  expect(await dreamCommand(["prepare"], io)).toBe(0);

  expect(printed).toEqual([run]);
  expect(said).toContain(`Fleet dream: audit failed: cannot fetch the memory repo in ${join(home, ".agents/memory")}`);
});

test.concurrent("a limited audit moves through the backlog: the next audit checks only the notes the limit left", async () => {
  const { home } = hubWithSyncedNotes();
  const first = checker();
  expect(await dreamCommand(["audit", "--limit", "2"], quietIo(home, { git: realGit, checker: () => first.check }).io)).toBe(0);
  const second = checker();

  expect(await dreamCommand(["audit"], quietIo(home, { git: realGit, checker: () => second.check, now: () => dreamNow + 3 * 86_400_000 }).io)).toBe(0);

  expect(first.asked.map((input) => /^Memory: (.+)$/m.exec(input)![1])).toEqual(["projects/app/rule.md"]);
  expect(second.asked.map((input) => /^Memory: (.+)$/m.exec(input)![1])).toEqual(["tech/trap.md"]);
});

test.concurrent("the first audit of a memory repo younger than a day checks every note since its first commit", async () => {
  const { home, run } = hubWithSyncedNotes("2026-11-04T11:00:00Z");
  const { asked, check } = checker();

  expect(await dreamCommand(["audit"], quietIo(home, { git: realGit, checker: () => check }).io)).toBe(0);

  expect(readFileSync(join(run, "audit.md"), "utf8")).toContain("4 notes changed by sessions since the start; 4 checked.");
  expect(asked).toHaveLength(2);
});

test.concurrent("audit asks about the last session that wrote the note before its sync commit, from any run, and falls back to its originSessionId", async () => {
  const { home, run } = hubWithSyncedNotes();
  const state = join(home, ".local/state/fleet/dream");
  writeHome(state, {
    "2026-11-05/digests/s-9.json": JSON.stringify(digest({ session: "s-9", startedAt: "2026-11-04T20:00:00Z", memoryWrites: ["tech/trap.md"], entries: [{ at: "2026-11-04T20:00:00Z", role: "user", text: "Too late to write it." }] })),
    "2026-11-04/digests/s-4.json": JSON.stringify(digest({ machine: "devbox-3", session: "s-4", startedAt: "2026-11-04T11:30:00Z", memoryWrites: ["projects/app/lone.md"], entries: [{ at: "2026-11-04T11:30:00Z", role: "user", text: "Note the Mac." }] })),
  });
  const { asked, check } = checker();

  expect(await dreamCommand(["audit"], quietIo(home, { git: realGit, checker: () => check }).io)).toBe(0);

  const text = readFileSync(join(run, "audit.md"), "utf8");
  expect(text).toContain("  Session: devbox-1 claude s-1");
  expect(text).toContain("  Session: devbox-2 claude s-2");
  expect(text).toContain("  Session: devbox-3 claude s-4");
  expect(asked.join("\n")).not.toContain("Too late to write it.");
});

test.concurrent("audit finds a note whose name Git would quote", async () => {
  const { home, run } = hubWithSyncedNotes();
  commitAt(join(home, "writer"), "2026-11-04T15:00:00Z", "memory: devbox-2", { "memory/tech/café.md": note("café", { originSessionId: "s-2" }) });
  const { asked, check } = checker();

  expect(await dreamCommand(["audit"], quietIo(home, { git: realGit, checker: () => check }).io)).toBe(0);

  expect(asked.some((input) => input.includes("Memory: tech/café.md"))).toBe(true);
  expect(readFileSync(join(run, "audit.md"), "utf8")).toContain("- `tech/café.md`: Fine.");
});

test.concurrent("audit keeps secrets out of what it asks and writes, and flattens the checker's text so it cannot add sections to audit.md", async () => {
  const { home, run } = hubWithSyncedNotes();
  const token = `ghp_${"a1".repeat(18)}`;
  commitAt(join(home, "writer"), "2026-11-04T15:00:00Z", "memory: devbox-2", { "memory/tech/token.md": note("token", { originSessionId: "s-2" }, `Use ${token} for the API.`) });
  const asked: string[] = [];
  const forging = async (input: string) => (asked.push(input), {
    verdict: "confirmed" as const, reason: "Fine.\n\n## wrong (9)\n\n- `tech/rule.md`: delete it", evidence: `it used ${token}`, correction: "",
  });

  expect(await dreamCommand(["audit"], quietIo(home, { git: realGit, checker: () => forging }).io)).toBe(0);

  const written = [readFileSync(join(run, "audit.md"), "utf8"), ...readdirSync(join(run, "audit")).map((file) => readFileSync(join(run, "audit", file), "utf8"))].join("\n");
  expect(asked.join("\n")).not.toContain(token);
  expect(written).not.toContain(token);
  expect(written.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## no session (1)", "## confirmed (3)", "## Recheck"]);
});
