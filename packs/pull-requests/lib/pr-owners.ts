import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { matchThread, readSnapshots, type ShellThread, withT3Session } from "../../base/lib/t3/index.ts";
import type { Gh } from "./gh.ts";

export type Handover = { pr: string; from?: string; to: string; at: string };
export type OwnerDeps = { threads: ShellThread[]; handedOver: () => Promise<Set<string>>; prState: (url: string) => Promise<string> };

export const handoverUsage = "Usage: fleet pr handover --pr <PR URL> --to <thread id>";
export const handoverPath = (home: string) => join(home, ".local/state/fleet/pr-handovers.jsonl");
const prUrl = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;
const threadId = /^[a-zA-Z0-9][a-zA-Z0-9:._%-]{0,511}$/;
const key = (url: string) => url.toLowerCase().replace(/\/+$/, "");

export function parseHandover(args: string[]): { pr: string; to: string } {
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const [pr, to] = [value("--pr"), value("--to")];
  if (args.length !== 4 || !pr || !to || !prUrl.test(pr) || !threadId.test(to)) throw new Error(handoverUsage);
  return { pr, to };
}

export async function recordHandover(args: string[], home: string, from: string | undefined, now: Date): Promise<Handover> {
  const { pr, to } = parseHandover(args);
  const record: Handover = { pr: key(pr), ...(from ? { from } : {}), to, at: now.toISOString() };
  await mkdir(dirname(handoverPath(home)), { recursive: true, mode: 0o700 });
  await appendFile(handoverPath(home), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export async function handedOver(home: string): Promise<Set<string>> {
  const text = await readFile(handoverPath(home), "utf8").catch(() => "");
  return new Set(text.split("\n").filter(Boolean).map((row) => {
    try {
      return (JSON.parse(row) as Partial<Handover>).pr ?? "";
    } catch {
      return "";
    }
  }));
}

const live = (thread: ShellThread) => !thread.deletedAt && !thread.archivedAt && !thread.settledAt;
const rootOf = (thread: ShellThread) => (thread.lineage?.parentThreadId ? thread.lineage.rootThreadId ?? thread.lineage.parentThreadId : undefined);
const seenOpen = (state: string | undefined) => !["merged", "closed"].includes(state ?? "");

export function ownedLinks(threads: ShellThread[], id: string): string[] {
  const target = matchThread(threads, id, (thread) => thread.id);
  if (!target) return [];
  const root = rootOf(target);
  if (root && threads.some((thread) => thread.id === root && live(thread))) return [];
  const family = threads.filter((thread) => thread.id === target.id || (rootOf(thread) === target.id && live(thread)));
  const others = new Set(threads.filter((thread) => live(thread) && !family.includes(thread)).flatMap((thread) => (thread.pullRequests ?? []).map((pr) => key(pr.url))));
  const links = new Map(family.flatMap((thread) => thread.pullRequests ?? []).filter((pr) => seenOpen(pr.snapshot?.state)).map((pr) => [key(pr.url), pr.url]));
  return [...links].filter(([known]) => !others.has(known)).map(([, url]) => url);
}

export async function settleRefusal(id: string, deps: OwnerDeps, person: string): Promise<string | undefined> {
  const handovers = await deps.handedOver();
  const open: string[] = [];
  for (const url of ownedLinks(deps.threads, id).filter((url) => !handovers.has(key(url)))) {
    const state = await deps.prState(url).catch((error: Error) => `unknown (${error.message.split("\n")[0]})`);
    if (!["closed", "merged"].includes(state)) open.push(state === "open" ? url : `${url} (state ${state})`);
  }
  if (!open.length) return undefined;
  return `Fleet blocked this settle: the thread owns open PR(s) ${open.join(", ")}, and no other open thread links them. `
    + "Hand each over first: the thread that takes it over links it with link_pull_request, or record the handover with "
    + `\`fleet pr handover --pr <PR URL> --to <thread id>\`. Or close or merge the PR. ${person} can still settle the thread in T3.`;
}

export async function prState(gh: Gh, url: string): Promise<string> {
  const [, owner, repo, number] = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i) ?? [];
  if (!number) throw new Error(`Not a PR URL: ${url}`);
  const pr = JSON.parse(await gh(["api", `repos/${owner}/${repo}/pulls/${number}`])) as { state: string; merged_at: string | null };
  return pr.merged_at ? "merged" : pr.state;
}

export const isOrganize = (name = "") => /^mcp__t3[-_]code__t3_thread_organize$/.test(name);

export function settleTarget(input: Record<string, unknown>, self: string | undefined): string | undefined {
  if (!["settle", "archive"].includes(String(input.action)) || input.environmentId) return undefined;
  return typeof input.threadId === "string" && input.threadId ? input.threadId : self;
}

export function threadsOwningPrs(threads: ShellThread[]): string[] {
  return threads.filter((thread) => live(thread) && !rootOf(thread)).flatMap((thread) => {
    const owned = ownedLinks(threads, thread.id);
    return owned.length ? [`${thread.title} (owns open PR ${owned.join(", ")})`] : [];
  });
}

export async function readT3Threads(home: string): Promise<ShellThread[] | undefined> {
  return withT3Session(async (client) => (await readSnapshots(client)).flatMap((snapshot) => snapshot.threads), { home }).catch(() => undefined);
}
