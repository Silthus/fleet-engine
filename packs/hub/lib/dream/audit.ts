import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Env, Result } from "../coder.ts";
import { reasonOf, render, type Ask } from "./analyze.ts";
import { frontmatterField, isIndex } from "./budget.ts";
import { clip, memoryCheckout, stateDir, type Digest } from "./digest.ts";
import { redactCredentials, redactValue } from "./redact.ts";
import { mostRead, recordRuns } from "./scorecard.ts";

export type Verdict = { verdict: "confirmed" | "wrong" | "unsupported"; reason: string; evidence: string; correction: string };
export type Checker = Ask<Verdict>;
export type AuditIo = { home: string; env: Env; now(): number; limit: number; git(args: string[]): Promise<Result>; checker: Checker; say(line: string): void };
type ChangedNote = { path: string; syncedAt: string; blob: string };
type AuditState = { audited?: string; checked?: Record<string, string> };
type Checked = { memory: string; session?: string; verdict: Omit<Verdict, "verdict"> & { verdict: Verdict["verdict"] | "no session" } };

const day = 86_400_000;
const jobs = 4;
const recheckDays = 30;
const verdictOrder = ["wrong", "unsupported", "no session", "confirmed"];

export const checkerPrompt = `You check one note that an agent wrote into the person's shared agent memory during a session. Below are the
note's change since the last check, its current text, and the condensed session that wrote it. Agents write memory
mid-task, so a note can be a guess, can overstate what happened, or can record the agent's own choice as the person's
rule. Decide:

- confirmed: the session shows the note's claims hold: the person said it, or the session tested it (a command ran, an
  error appeared, a fix worked).
- wrong: the session shows a claim is false, overstated, or later disproved, or the note turns the agent's own
  choice or a one-task decision into a rule.
- unsupported: the session neither shows nor disproves it.

Give the reason in one sentence and quote short evidence from the session. When wrong, put the corrected text in
correction, or an empty string when the note should go. Never repeat a secret or token.`;

export const checkerSchema = {
  type: "object", required: ["verdict", "reason", "evidence", "correction"], additionalProperties: false,
  properties: { verdict: { enum: ["confirmed", "wrong", "unsupported"] }, reason: { type: "string" }, evidence: { type: "string" }, correction: { type: "string" } },
};

const runDirs = (state: string) => existsSync(state) ? readdirSync(state).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort() : [];

function digestsOf(run: string): Digest[] {
  const dir = join(run, "digests");
  return existsSync(dir) ? readdirSync(dir).sort().map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Digest) : [];
}

function sessionOf(digests: Digest[], session: string): Digest | undefined {
  let found: Digest | undefined;
  for (const item of digests) {
    if (item.session !== session) continue;
    const after = found?.entries.at(-1)?.at ?? "";
    found = found ? { ...item, entries: [...found.entries, ...item.entries.filter((entry) => entry.at > after)] } : { ...item, entries: [...item.entries] };
  }
  return found;
}

function writerOf(digests: Digest[], note: ChangedNote, origin: string | undefined): Digest | undefined {
  const before = digests.filter((item) => item.memoryWrites.includes(note.path) && Date.parse(item.startedAt) <= Date.parse(note.syncedAt));
  const latest = before.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).at(-1);
  return latest ? sessionOf(digests, latest.session) : origin ? sessionOf(digests, origin) : undefined;
}

const isNote = (path: string) => path.endsWith(".md") && !isIndex(path) && !path.split("/").some((part) => part.startsWith("."));
const oneLine = (text: string) => redactCredentials(text).replace(/\s+/g, " ").trim();

function readText(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function changedNotes(git: (...args: string[]) => Promise<Result>, since: string, head: string, checked: Record<string, string>): Promise<ChangedNote[]> {
  if (since === head) return [];
  const log = await git("log", "-z", "--format=%x1e%cI%x1f%s", "--name-only", "--no-renames", "--relative", since ? `${since}..${head}` : head, "--", ".");
  if (log.code !== 0) throw new Error(`cannot read the memory repo's history from ${since ? since.slice(0, 12) : "the start"}`);
  const changed = new Map<string, ChangedNote>();
  for (const chunk of log.stdout.split("\x1e").slice(1)) {
    const [header = "", ...paths] = chunk.split("\0");
    const [syncedAt = "", subject = ""] = header.split("\x1f");
    if (!subject.startsWith("memory: ")) continue;
    for (const path of paths.map((name) => name.replace(/^\n/, "")).filter((name) => isNote(name) && !changed.has(name))) {
      const blob = (await git("rev-parse", "--verify", "--quiet", `${head}:./${path}`)).stdout.trim();
      if (blob && checked[path] !== blob) changed.set(path, { path, syncedAt, blob });
    }
  }
  return [...changed.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function question(memory: string, change: string, text: string, writer: Digest) {
  return redactCredentials([`Memory: ${memory}`, `Change since the last check:\n${clip(change, 6000)}`, `Current text:\n${clip(text, 6000)}`, `Session:\n${render(writer)}`].join("\n\n"));
}

function recheck(state: string, checkout: string, now: number) {
  recordRuns(state, now);
  return mostRead(state, recheckDays, now).filter(({ path }) => {
    const text = readText(join(checkout, path));
    const touched = Math.max(0, ...["modified", "verified"].map((name) => Date.parse(frontmatterField(text, name) ?? "") || 0));
    return text && now - touched > recheckDays * day;
  }).slice(0, 5);
}

function report(run: string, since: string, changed: number, limit: number, results: Checked[], failed: string[], rechecks: Array<{ path: string; sessions: number }>) {
  const groups = verdictOrder.flatMap((verdict) => {
    const group = results.filter((result) => result.verdict.verdict === verdict).sort((a, b) => a.memory.localeCompare(b.memory));
    return group.length ? [`## ${verdict} (${group.length})`, "", ...group.map(({ memory, session, verdict: answer }) => [
      `- \`${memory}\`: ${oneLine(answer.reason)}`,
      ...(answer.evidence ? [`  Evidence: ${oneLine(answer.evidence)}`] : []),
      ...(answer.correction ? [`  Correction: ${oneLine(answer.correction)}`] : []),
      ...(session ? [`  Session: ${session}`] : []),
    ].join("\n")), ""] : [];
  });
  return [
    `# Write audit ${basename(run)}`, "",
    `${changed} notes changed by sessions since ${since ? since.slice(0, 12) : "the start"}; ${results.length} checked.${changed > limit ? ` ${changed - limit} left for the next run by --limit.` : ""}`,
    failed.length ? `Checks failed on:\n${failed.map((line) => `- ${line}`).join("\n")}` : "", "",
    ...groups,
    "## Recheck", "",
    rechecks.length ? "The most-read notes that nobody wrote or verified for 30 days. Check each against the code or the machines." : "No much-read note is older than 30 days.",
    ...rechecks.map(({ path, sessions }) => `- \`${path}\`: read or shown in ${sessions} sessions`),
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}

export async function audit(run: string, io: AuditIo): Promise<string> {
  const checkout = memoryCheckout(io.home, io.env);
  const state = stateDir(io.home, io.env);
  const git = (...args: string[]) => io.git(["-C", checkout, ...args]);
  if ((await git("fetch", "--quiet", "origin", "main")).code !== 0) throw new Error(`cannot fetch the memory repo in ${checkout}`);
  const head = (await git("rev-parse", "--verify", "origin/main")).stdout.trim();
  if (!head) throw new Error(`the memory repo in ${checkout} has no origin/main`);
  const statePath = join(state, "audit.json");
  const saved = (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}) as AuditState;
  const since = saved.audited !== undefined && (saved.audited === "" || (await git("cat-file", "-e", `${saved.audited}^{commit}`)).code === 0)
    ? saved.audited
    : (await git("rev-list", "-1", `--before=${new Date(io.now() - day).toISOString()}`, "origin/main")).stdout.trim();
  const checked = since === saved.audited ? { ...saved.checked } : {};
  const changed = await changedNotes(git, since, head, checked);
  const digests = runDirs(state).flatMap((name) => digestsOf(join(state, name)));
  mkdirSync(join(run, "audit"), { recursive: true, mode: 0o700 });
  const chosen = changed.slice(0, io.limit);
  const results: Checked[] = [];
  const failed: string[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < chosen.length) {
      const note = chosen[next++]!;
      const memory = note.path;
      try {
        const text = (await git("show", `${head}:./${memory}`)).stdout;
        const writer = writerOf(digests, note, frontmatterField(text, "originSessionId"));
        const change = since ? (await git("diff", since, head, "--relative", "--", memory)).stdout : text;
        const verdict: Checked["verdict"] = writer
          ? redactValue(await io.checker(question(memory, change, text, writer), run)) as Verdict
          : { verdict: "no session", reason: "No digest of the writing session is on the hub: a Mac session, or one older than the runs.", evidence: "", correction: "" };
        const session = writer && `${writer.machine} ${writer.provider} ${writer.session}`;
        writeFileSync(join(run, "audit", `${memory.replaceAll("/", "__")}.json`), JSON.stringify({ memory, session, verdict }), { mode: 0o600 });
        results.push({ memory, session, verdict });
        checked[memory] = note.blob;
      } catch (error) {
        failed.push(`${memory}: ${reasonOf(error)}`);
      }
    }
  }));
  const complete = !failed.length && changed.length <= io.limit;
  writeFileSync(statePath, JSON.stringify(complete ? { audited: head, checked: {} } : { audited: since, checked }), { mode: 0o600 });
  writeFileSync(join(run, "audit.md"), report(run, since, changed.length, io.limit, results, failed, recheck(state, checkout, io.now())), { mode: 0o600 });
  io.say(`Fleet dream: audited ${results.length} of ${changed.length} notes written since the last audit. Audit: ${join(run, "audit.md")}`);
  return run;
}
