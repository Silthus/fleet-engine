import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PrRef } from "./decision-ledger.ts";
import { publishedUrl } from "./proof-publish.ts";
import { prDirectory, proofKind, readJson, writeJson, type ProofIdentity, type ProofKind } from "./proof.ts";

export type ProofLines = { ran: string; result: string };
type Caption = { caption: string; captionedAt: string; commit: string; name: string };
export type Screenshot = Caption & { url?: string };
export type Display = { lines: Record<string, Partial<Record<ProofKind, ProofLines>>>; screenshots: Screenshot[] };

export const displayEntry = "display";
const displayDirectory = (home: string, ref: PrRef) => join(prDirectory(home, ref), displayEntry);
const linesPath = (home: string, identity: ProofIdentity, kind: ProofKind) => join(displayDirectory(home, identity), "lines", identity.commit, `${kind}.json`);
const captionPath = (home: string, identity: ProofIdentity, name: string) => join(displayDirectory(home, identity), "captions", identity.commit, `${name}.json`);

export function displayLine(value: string, option: string) {
  const line = value.trim();
  if (!line || /[\r\n]/.test(line)) throw new Error(`${option} needs one line of text`);
  return line;
}

export async function recordLines(home: string, identity: ProofIdentity, kind: string, ran: string, result: string) {
  const lines: ProofLines = { ran: displayLine(ran, "--ran"), result: displayLine(result, "--result") };
  await writeJson(linesPath(home, identity, proofKind(kind)), lines);
  return lines;
}

export async function recordCaption(home: string, identity: ProofIdentity, saved: string, caption: string, now: Date) {
  const name = basename(saved);
  const path = captionPath(home, identity, name);
  const earlier = await readJson<Caption | undefined>(path, undefined);
  const record: Caption = { caption: displayLine(caption, "--caption"), captionedAt: earlier?.captionedAt ?? now.toISOString(), commit: identity.commit, name };
  await writeJson(path, record);
  return record;
}

async function entries(directory: string) {
  try { return await readdir(directory); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return []; throw error; }
}

async function records<T>(directory: string) {
  const found: { commit: string; file: string; record: T }[] = [];
  for (const commit of await entries(directory)) {
    for (const file of (await entries(join(directory, commit))).filter((name) => name.endsWith(".json"))) {
      const record = await readJson<T | undefined>(join(directory, commit, file), undefined);
      if (record) found.push({ commit, file, record });
    }
  }
  return found;
}

export async function readDisplay(home: string, ref: PrRef): Promise<Display> {
  const root = displayDirectory(home, ref);
  const lines: Display["lines"] = {};
  for (const { commit, file, record } of await records<ProofLines>(join(root, "lines"))) (lines[commit] ??= {})[file.slice(0, -5) as ProofKind] = { ran: record.ran, result: record.result };
  const captions = (await records<Caption>(join(root, "captions"))).map(({ record }) => record);
  captions.sort((a, b) => a.captionedAt.localeCompare(b.captionedAt) || a.name.localeCompare(b.name));
  const screenshots = await Promise.all(captions.map(async (caption) => {
    const url = await publishedUrl(join(prDirectory(home, ref), caption.commit, caption.name));
    return url === undefined ? caption : { ...caption, url };
  }));
  return { lines, screenshots };
}
