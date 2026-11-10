import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryRoot, stateDir } from "./notes.ts";

export type Trigger = { note: string; terms: string[] };

export const minimumTerm = 4;

const tableFile = (home: string) => join(stateDir(home), "triggers.json");
const frontmatterOf = (text: string) => /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "").trim();

export function stripFrontmatter(text: string) {
  const match = frontmatterOf(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

export function triggersOf(text: string): string[] {
  const block = frontmatterOf(text)?.[1] ?? "";
  const inline = /^\s*triggers:[ \t]*\[(.*)\][ \t]*$/m.exec(block);
  if (inline) return inline[1]!.split(",").map(unquote).filter(Boolean);
  const start = /^\s*triggers:[ \t]*$/m.exec(block);
  if (!start) return [];
  const items: string[] = [];
  for (const line of block.slice(start.index + start[0].length).split("\n").slice(1)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (!item) break;
    items.push(unquote(item[1]!));
  }
  return items.filter(Boolean);
}

export function noteFiles(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name.startsWith(".")) return [];
    if (entry.isDirectory()) return noteFiles(root, path);
    return entry.name.endsWith(".md") && entry.name !== "MEMORY.md" && entry.name !== "INDEX.md" ? [path] : [];
  });
}

export function refreshTriggers(home: string): Trigger[] {
  const root = memoryRoot(home);
  const table = noteFiles(root).flatMap((note) => {
    const terms = triggersOf(readFileSync(join(root, note), "utf8")).filter((term) => term.length >= minimumTerm);
    return terms.length ? [{ note, terms }] : [];
  });
  mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  const draft = `${tableFile(home)}.${process.pid}.tmp`;
  writeFileSync(draft, JSON.stringify(table), { mode: 0o600 });
  renameSync(draft, tableFile(home));
  return table;
}

export function readTriggers(home: string): Trigger[] {
  try {
    const table = JSON.parse(readFileSync(tableFile(home), "utf8"));
    if (Array.isArray(table)) return table as Trigger[];
  } catch {}
  return refreshTriggers(home);
}

const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const names = (term: string, call: string) => new RegExp(`(?<![\\w-])${escape(term)}(?![\\w-])`, "i").test(call);
