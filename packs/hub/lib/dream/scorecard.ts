import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Finding, Findings } from "./analyze.ts";
import { isIndex, notMemory } from "./budget.ts";
import type { Digest, Effort } from "./digest.ts";

type Hit = Pick<Finding, "kind" | "reach" | "memory" | "importance"> & { topic: string };
export type SessionRecord = {
  machine: string; provider: string; repo: string; startedAt: string; endedAt: string;
  taskType?: string; tokens?: number; effort?: Effort; memoryReads: string[]; memoryShown?: string[];
  parts: Record<string, Hit[]>;
};
type Ledger = Record<string, SessionRecord>;
export type Memory = { path: string; name: string; addedAt: string; topics: Set<string> };
export type Git = (args: string[]) => Promise<string>;

const mistakes = new Set(["repeated-failure", "correction", "missing-knowledge"]);
const keepWeeks = 26;
const day = 86_400_000;
const slug = (value: string) => basename(value.trim(), ".md").toLowerCase();
const isMemory = (path: string) => path.endsWith(".md") && !isIndex(path) && path !== "README.md" && !notMemory.has(path.split("/")[0]!);

const readLedger = (state: string): Ledger => existsSync(join(state, "ledger.json")) ? JSON.parse(readFileSync(join(state, "ledger.json"), "utf8")) : {};

export function recordRuns(state: string, now = Date.now()): number {
  const ledger = readLedger(state);
  for (const run of readdirSync(state).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))) {
    const findings = join(state, run, "findings");
    if (!existsSync(findings)) continue;
    for (const file of readdirSync(findings)) {
      const digestPath = join(state, run, "digests", file);
      if (!existsSync(digestPath)) continue;
      const item = JSON.parse(readFileSync(digestPath, "utf8")) as Digest;
      const parsed = JSON.parse(readFileSync(join(findings, file), "utf8"));
      const answer: Findings = Array.isArray(parsed) ? { findings: parsed } : parsed;
      const key = `${item.provider}:${item.session}`;
      const known = ledger[key];
      const latest = !known || known.endedAt <= item.endedAt;
      ledger[key] = {
        ...known,
        ...(latest ? {
          machine: item.machine, provider: item.provider, repo: item.repo, startedAt: known?.startedAt || item.startedAt, endedAt: item.endedAt,
          tokens: item.tokens, effort: item.effort ?? known?.effort,
        } : {}),
        taskType: known?.taskType ?? answer.taskType,
        memoryReads: [...new Set([...(known?.memoryReads ?? []), ...item.memoryReads])],
        memoryShown: [...new Set([...(known?.memoryShown ?? []), ...(item.memoryShown ?? [])])],
        parts: {
          ...known?.parts,
          [file]: answer.findings.map((finding) => ({
            kind: finding.kind, reach: finding.reach, memory: finding.memory, importance: finding.importance,
            topic: slug(finding.topic || finding.memory || ""),
          })),
        },
      } as SessionRecord;
    }
  }
  const cutoff = new Date(now - keepWeeks * 7 * day).toISOString();
  for (const [key, record] of Object.entries(ledger)) if ((record.startedAt || record.endedAt) < cutoff) delete ledger[key];
  writeFileSync(join(state, "ledger.json"), JSON.stringify(ledger), { mode: 0o600 });
  return Object.keys(ledger).length;
}

export async function readMemories(checkout: string, git: Git): Promise<Memory[]> {
  const memories = new Map<string, Memory>();
  const chunks = (await git(["log", "--reverse", "--find-renames", "--name-status", "--format=%x1e%cI%x1f%B%x1f"])).split("\x1e").slice(1);
  for (const chunk of chunks) {
    const [date = "", body = "", changes = ""] = chunk.split("\x1f");
    const topics = [...body.matchAll(/^Topics?:\s*(.+)$/gim)].flatMap((match) => match[1]!.split(/[,\s]+/)).map(slug).filter(Boolean);
    for (const line of changes.trim().split("\n").filter(Boolean)) {
      const [status = "", from = "", to] = line.split("\t");
      if (!isMemory(to ?? from)) continue;
      if (status.startsWith("D")) { memories.delete(from); continue; }
      const path = status.startsWith("R") ? to! : from;
      const memory = memories.get(from) ?? { path, name: slug(path), addedAt: date, topics: new Set<string>() };
      if (status.startsWith("R")) memories.delete(from);
      memory.path = path;
      memory.name = slug(path);
      memory.topics.add(memory.name);
      for (const topic of topics) memory.topics.add(topic);
      memories.set(path, memory);
    }
  }
  const merged = (await git(["log", "--first-parent", "-m", "--diff-filter=A", "--name-only", "--format=%x1e%cI"])).split("\x1e").slice(1);
  for (const chunk of merged) {
    const [date = "", ...paths] = chunk.trim().split("\n");
    for (const path of paths.filter(Boolean)) {
      const memory = memories.get(path);
      if (memory && memory.addedAt < date) memory.addedAt = date;
    }
  }
  return [...memories.values()].filter((memory) => existsSync(join(checkout, memory.path)));
}

export function mostRead(state: string, days: number, now: number): Array<{ path: string; sessions: number }> {
  const cutoff = new Date(now - days * day).toISOString();
  const counts = new Map<string, number>();
  for (const record of Object.values(readLedger(state))) {
    if ((record.endedAt || "") < cutoff) continue;
    for (const path of new Set([...record.memoryReads, ...(record.memoryShown ?? [])])) if (!isIndex(path)) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts].map(([path, sessions]) => ({ path, sessions })).sort((a, b) => b.sessions - a.sessions || a.path.localeCompare(b.path));
}

type Session = SessionRecord & { key: string; week: string; hits: Hit[] };

export function weekOf(at: string): string {
  const date = new Date(at.slice(0, 10));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

const median = (values: number[]) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
const share = (count: number, total: number) => total ? count / total : undefined;
const rate = (hits: number, total: number) => total ? hits / total : 0;
const rate100 = (hits: number, total: number) => total ? hits / total * 100 : undefined;

export type Card = ReturnType<typeof scorecard>;

export function scorecard(ledger: Ledger, memories: Memory[], usage: Record<string, string>, now: number) {
  const byTopic = new Map<string, Memory[]>();
  for (const memory of memories) for (const topic of memory.topics) byTopic.set(topic, [...(byTopic.get(topic) ?? []), memory]);
  const covering = (hit: Hit) => [...new Set([...(byTopic.get(hit.topic) ?? []), ...(hit.memory ? byTopic.get(slug(hit.memory)) ?? [] : [])])];
  const sessions: Session[] = Object.entries(ledger).filter(([, record]) => record.startedAt).map(([key, record]) => ({
    ...record, key, week: weekOf(record.startedAt), hits: Object.values(record.parts).flat(),
  }));
  const reads = (session: Session) => new Set([...session.memoryReads, ...(session.memoryShown ?? [])].filter((path) => !isIndex(path)));
  const repeats = (session: Session) => new Set(session.hits.filter((hit) => mistakes.has(hit.kind))
    .flatMap(covering).filter((memory) => memory.addedAt < session.startedAt));
  const misses = (session: Session) => [...repeats(session)].filter((memory) => !reads(session).has(memory.path));

  const strata = new Map<string, Session[]>();
  for (const session of sessions.filter((item) => item.effort && item.taskType)) {
    const key = `${session.repo}/${session.taskType}`;
    strata.set(key, [...(strata.get(key) ?? []), session]);
  }
  const typical = new Map([...strata].map(([key, group]) => [key, { tokens: median(group.map((item) => item.effort!.tokens)) ?? 0, toolCalls: median(group.map((item) => item.effort!.toolCalls)) ?? 0 }]));
  const effortIndex = (group: Session[], field: "tokens" | "toolCalls") => median(group.flatMap((session) => {
    const base = session.effort && session.taskType ? typical.get(`${session.repo}/${session.taskType}`)?.[field] : undefined;
    return base ? [session.effort![field] / base] : [];
  }));
  const measure = (group: Session[]) => ({
    sessions: group.length,
    repeatsPer100: (share(group.filter((session) => repeats(session).size > 0).length, group.length) ?? NaN) * 100,
    reach: share(group.filter((session) => reads(session).size > 0).length, group.length),
    missesPer100: (share(group.filter((session) => misses(session).length > 0).length, group.length) ?? NaN) * 100,
    correctionsPerSession: share(group.flatMap((session) => session.hits.filter((hit) => hit.kind === "correction")).length, group.length),
    tokensIndex: effortIndex(group, "tokens"),
    toolCallsIndex: effortIndex(group, "toolCalls"),
    errorsBeforeEdit: mean(group.flatMap((session) => session.effort ? [session.effort.errors] : [])),
  });

  const thisWeek = weekOf(new Date(now).toISOString());
  const weeks = [...new Set(sessions.map((session) => session.week))].filter((week) => week < thisWeek).sort().reverse().slice(0, 4);
  const weekly = weeks.map((week) => ({ week, ...measure(sessions.filter((session) => session.week === week)) }));

  const ledgerStart = sessions.map((session) => session.startedAt).sort()[0] ?? "";
  const perMemory = memories.map((memory) => {
    const before = sessions.filter((session) => session.startedAt < memory.addedAt);
    const after = sessions.filter((session) => session.startedAt > memory.addedAt);
    const hitBy = (session: Session) => session.hits.some((hit) => mistakes.has(hit.kind) && covering(hit).includes(memory));
    const recurring = after.filter(hitBy);
    const opened = after.filter((session) => reads(session).has(memory.path));
    return {
      memory,
      hitsBefore: before.filter(hitBy).length, sessionsBefore: before.length,
      hitsAfter: recurring.length, sessionsAfter: after.length,
      recurringWhileRead: recurring.filter((session) => reads(session).has(memory.path)).length,
      opened: opened.length || ((usage[memory.path] ?? "") > memory.addedAt ? 1 : 0),
      helped: sessions.flatMap((session) => session.hits).filter((hit) => hit.kind === "memory-helped" && covering(hit).includes(memory)).length,
      ageDays: Math.floor((now - Date.parse(memory.addedAt)) / day),
    };
  });
  const payoff = (item: typeof perMemory[number]) => item.helped
    + Math.max(0, rate(item.hitsBefore, item.sessionsBefore) - rate(item.hitsAfter, item.sessionsAfter)) * item.sessionsAfter;
  const best = perMemory.filter((item) => payoff(item) > 0).sort((a, b) => payoff(b) - payoff(a)).slice(0, 3);
  const verdict = (item: typeof perMemory[number]) =>
    item.recurringWhileRead ? `recurs although read (${item.recurringWhileRead}): rewrite it or turn it into a check`
      : item.hitsAfter ? `recurs and was never opened (${item.hitsAfter}): sharpen its index line`
        : !item.opened && !item.helped && item.ageDays >= 14 ? `not read in ${item.ageDays} days: prune it` : undefined;
  const worst = perMemory.filter((item) => item.ageDays >= 7 && verdict(item) && !best.includes(item))
    .sort((a, b) => b.recurringWhileRead - a.recurringWhileRead || b.hitsAfter - a.hitsAfter || b.ageDays - a.ageDays).slice(0, 3);
  const compared = perMemory.filter((item) => item.sessionsBefore && item.sessionsAfter && item.memory.addedAt > ledgerStart);
  const beforeAfter = {
    memories: compared.filter((item) => item.hitsBefore || item.hitsAfter).length,
    before: rate(compared.reduce((sum, item) => sum + item.hitsBefore, 0), compared.reduce((sum, item) => sum + item.sessionsBefore, 0)) * 100,
    after: rate(compared.reduce((sum, item) => sum + item.hitsAfter, 0), compared.reduce((sum, item) => sum + item.sessionsAfter, 0)) * 100,
  };
  return { weekly, beforeAfter, best: best.map((item) => ({ ...item, payoff: payoff(item) })), worst: worst.map((item) => ({ ...item, verdict: verdict(item)! })), sessions: sessions.length };
}

const show = (value: number | undefined, digits = 1) => value === undefined || Number.isNaN(value) ? "–" : value.toFixed(digits);
const percent = (value: number | undefined) => value === undefined ? "–" : `${Math.round(value * 100)}%`;

export function renderScorecard(card: Card): string {
  const { weekly, beforeAfter } = card;
  const row = (label: string, pick: (week: Card["weekly"][number]) => string) => `| ${label} | ${weekly.map(pick).join(" | ")} |`;
  const lines = [
    "## Memory scorecard", "",
    weekly.length ? `| Week of | ${weekly.map((week) => week.week.slice(5)).join(" | ")} |` : "No complete week in the ledger yet.",
    ...(weekly.length ? [
      `| --- |${weekly.map(() => " --- |").join("")}`,
      row("1. Repeat mistakes on remembered topics, per 100 sessions", (week) => show(week.repeatsPer100)),
      row("2. Reach: sessions that read a memory", (week) => percent(week.reach)),
      row("   Misses: covered but unread, per 100 sessions", (week) => show(week.missesPer100)),
      row("3. Corrections per session", (week) => show(week.correctionsPerSession, 2)),
      row("4. Tokens before first edit (1.00 = typical for repo and task)", (week) => show(week.tokensIndex, 2)),
      row("   Tool calls before first edit (same scale)", (week) => show(week.toolCallsIndex, 2)),
      row("   Errors before first edit, mean", (week) => show(week.errorsBeforeEdit, 2)),
      row("Sessions", (week) => String(week.sessions)),
    ] : []),
    "",
    beforeAfter.memories ? `Before and after a memory merged: ${show(beforeAfter.before)} → ${show(beforeAfter.after)} repeats per 100 sessions on its topics, across ${beforeAfter.memories} memories.` : "No memory has sessions before and after its merge yet.",
    "", "**Paid off most**",
    ...(card.best.length ? card.best.map((item, index) => `${index + 1}. \`${item.memory.path}\`: helped ${item.helped}, repeats ${show(rate100(item.hitsBefore, item.sessionsBefore))} → ${show(rate100(item.hitsAfter, item.sessionsAfter))} per 100 sessions`) : ["None yet."]),
    "", "**Paid off least**",
    ...(card.worst.length ? card.worst.map((item, index) => `${index + 1}. \`${item.memory.path}\`: ${item.verdict}`) : ["None yet."]),
  ];
  return `${lines.join("\n")}\n`;
}

export async function scorecardText(state: string, checkout: string, git: Git, now: number): Promise<string> {
  if (!existsSync(state)) return "No dream state on this machine. Run the scorecard on the hub.\n";
  recordRuns(state, now);
  const usagePath = join(state, "usage.json");
  return renderScorecard(scorecard(readLedger(state), await readMemories(checkout, git), existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, "utf8")) : {}, now));
}
