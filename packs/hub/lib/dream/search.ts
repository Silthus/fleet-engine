import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactDigest, sessionKeepDays, type Digest } from "./digest.ts";

const shownHits = 20;
const shownLines = 3;
const snippetLength = 300;

function readLines(path: string): Digest[] {
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      return line.trim() ? [redactDigest(JSON.parse(line) as Digest)] : [];
    } catch {
      return [];
    }
  });
}

function storedDigests(state: string): Digest[] {
  const runs = existsSync(state) ? readdirSync(state).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)) : [];
  const fromRuns = runs.flatMap((run) => {
    const dir = join(state, run, "digests");
    return existsSync(dir) ? readdirSync(dir).flatMap((file) => readLines(join(dir, file))) : [];
  });
  const inbox = join(state, "inbox");
  return [...fromRuns, ...(existsSync(inbox) ? readdirSync(inbox).flatMap((file) => readLines(join(inbox, file))) : [])];
}

function snippet(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  const at = Math.max(0, Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0)) - 80);
  return `${at ? "…" : ""}${text.slice(at, at + snippetLength).replaceAll("\n", " ")}${text.length > at + snippetLength ? "…" : ""}`;
}

export function searchSessions(state: string, words: string[], { since }: { since: number }): string {
  const terms = words.map((word) => word.toLowerCase());
  const sessions = new Map<string, Digest>();
  for (const item of storedDigests(state)) {
    const key = `${item.provider}:${item.session}`;
    const known = sessions.get(key);
    const entries = known ? [...known.entries, ...item.entries.filter((entry) => !known.entries.some((old) => old.at === entry.at && old.text === entry.text))] : item.entries;
    sessions.set(key, { ...(known && known.endedAt > item.endedAt ? known : item), entries });
  }
  const hits = [...sessions.values()]
    .filter((item) => Date.parse(item.endedAt) >= since)
    .filter((item) => {
      const text = item.entries.map((entry) => entry.text).join("\n").toLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  if (!hits.length) return `No session in the last ${sessionKeepDays} days names ${words.map((word) => `"${word}"`).join(" and ")}.\n`;
  const blocks = hits.slice(0, shownHits).map((item) => {
    const matching = item.entries.filter((entry) => terms.some((term) => entry.text.toLowerCase().includes(term))).slice(0, shownLines);
    return [`${item.endedAt.slice(0, 16)} ${item.machine} ${item.provider} ${item.session} (${item.repo})`, ...matching.map((entry) => `  [${entry.role}] ${snippet(entry.text, terms)}`)].join("\n");
  });
  return `${blocks.join("\n\n")}\n${hits.length > shownHits ? `\n${hits.length - shownHits} more sessions match; add a word to narrow it.\n` : ""}`;
}
