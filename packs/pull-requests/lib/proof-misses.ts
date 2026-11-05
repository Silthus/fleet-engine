import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ledgerRoot } from "./proof.ts";

export const missSources = ["human", "bot", "ci", "rollback", "revert"] as const;
export type MissSource = (typeof missSources)[number];

export type Miss = {
  id: string; at: string; repo: string; pr: number; commit: string; source: MissSource; finding: string;
  file?: string; line?: number; url?: string;
  base: string; head: string; scope: string; round: string; reviewer?: string; title: string; body: string;
};

export const missesPath = (home: string) => join(ledgerRoot(home), "misses.jsonl");

export function missSource(value: string): MissSource {
  if (!(missSources as readonly string[]).includes(value)) throw new Error(`Unknown miss source ${value}. Use one of ${missSources.join(", ")}`);
  return value as MissSource;
}

export async function appendLine(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, JSON.stringify(value) + "\n", { mode: 0o600 });
}

export async function readLines<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

export const readMisses = (home: string) => readLines<Miss>(missesPath(home));

export async function recordMiss(home: string, miss: Omit<Miss, "id" | "at">, now: Date) {
  if (!miss.finding.trim()) throw new Error("--finding needs what the reviewer should have flagged");
  const id = hashOf([miss.repo, String(miss.pr), miss.commit, miss.finding.trim()]).slice(0, 10);
  if ((await readMisses(home)).some((recorded) => recorded.id === id)) throw new Error(`This miss is already recorded as case ${id}`);
  const recorded: Miss = { id, at: now.toISOString(), ...miss, finding: miss.finding.trim() };
  await appendLine(missesPath(home), recorded);
  return recorded;
}

export const hashOf = (parts: string[]) => parts.reduce((hash, part) => hash.update(part).update("\0"), createHash("sha256")).digest("hex");
