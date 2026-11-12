import {
  lastActivityAt, listLinkedProjects, listLinkedThreads, readLinkedItemText, readLinkedThread, readLinkedThreadWords, readSnapshots, readThread, readThreadWords, readTurnItems, withT3Session,
  type LinkedThread, type LinkedTimelineItem, type ShellPullRequest, type ShellSnapshot, type T3Client, type T3HttpClient, type T3SessionOptions, type ThreadWord,
} from "../../base/lib/t3/index.ts";
import { liveStatuses, pickMachine, readEachMachine, readMachines, type MachineReport } from "./machines.ts";

export type Work = {
  id: string; title: string; project: string; status: string; branch: string | null;
  pullRequests: ShellPullRequest[]; messages: string[];
};
export type OpenWork = Work & { snoozedUntil: string | null; waiting: boolean; updatedAt: string };
export type Activity = {
  id: string; title: string; project: string; status: string; busy: boolean; updatedAt: string;
  archived: boolean; worktree: string | null; model: string | null; error: string | null; latestMessage: string | null;
};
export type ActivityReport = MachineReport<{ threads?: Activity[]; thread?: unknown; words?: ThreadWord[]; work?: Work[] }>;
export type ActivityIo = { home: string; host: string; print(line: string): void; session?: T3SessionOptions };

type Query =
  | { kind: "recent"; limit: number }
  | { kind: "open" }
  | { kind: "since"; since: Date }
  | { kind: "thread"; threadId: string; words: boolean };
type Request = { query: Query; host?: string; local: boolean; json: boolean };

const usage = "Usage: fleet activity [host] [--local] [--thread id [--words] | --since time | --open] [--limit count] [--json]";
const threadIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9:._%-]{0,511}$/;
const latestMessageCap = 1000;

export async function readActivity(client: T3Client, limit: number): Promise<Activity[]> {
  const [shell, archive] = await readSnapshots(client);
  const projects = new Map([...archive.projects, ...shell.projects].map((project) => [project.id, project]));
  const threads = [...shell.threads, ...archive.threads].filter((thread) => !thread.deletedAt).map((thread): Activity => {
    const status = thread.activityRunStatus ?? thread.status;
    const busy = Boolean(thread.activeRunId || thread.pendingRuntimeRequest || thread.pendingBackgroundTasks?.some((task) => task.kind !== "command")) || liveStatuses.includes(status);
    return {
      id: thread.id, title: thread.title, project: projects.get(thread.projectId)?.title ?? thread.projectId,
      status, busy, updatedAt: lastActivityAt(thread), archived: Boolean(thread.archivedAt),
      worktree: thread.worktreePath ?? projects.get(thread.projectId)?.workspaceRoot ?? null,
      model: thread.modelSelection?.model ?? null, error: thread.lastError ?? null,
      latestMessage: thread.latestVisibleMessage?.text.slice(0, latestMessageCap) ?? null,
    };
  });
  return busyAndRecent(threads, limit);
}

export async function readWorkSince(client: T3HttpClient, since: Date): Promise<Work[]> {
  const [shell, archive] = await readSnapshots(client);
  const projects = new Map([...archive.projects, ...shell.projects].map((project) => [project.id, project.title]));
  const from = since.toISOString();
  const threads = [...shell.threads, ...archive.threads].filter((thread) =>
    !thread.deletedAt && !thread.lineage?.parentThreadId && (thread.latestUserAuthoredMessageAt ?? "") >= from);
  return Promise.all(threads.map(async (thread) => ({
    id: thread.id, title: thread.title, project: projects.get(thread.projectId) ?? thread.projectId,
    status: thread.activityRunStatus ?? thread.status, branch: thread.branch ?? null,
    pullRequests: pullRequestKeys(thread.pullRequests ?? []),
    messages: await readUserMessagesSince(client, thread.id, from),
  })));
}

export async function readOpenWork(client: T3Client): Promise<OpenWork[]> {
  const shell = await client.getShell<ShellSnapshot>();
  const projects = new Map(shell.projects.map((project) => [project.id, project.title]));
  const open = shell.threads.filter((thread) => !thread.deletedAt && !thread.archivedAt && !thread.settledAt);
  const childPullRequests = new Map<string, ShellPullRequest[]>();
  for (const child of open.filter((thread) => thread.lineage?.parentThreadId)) {
    const root = child.lineage!.rootThreadId ?? child.lineage!.parentThreadId!;
    childPullRequests.set(root, [...childPullRequests.get(root) ?? [], ...child.pullRequests ?? []]);
  }
  return open.filter((thread) => !thread.lineage?.parentThreadId).map((thread) => ({
    id: thread.id, title: thread.title, project: projects.get(thread.projectId) ?? thread.projectId,
    status: thread.activityRunStatus ?? thread.status, branch: thread.branch ?? null,
    pullRequests: uniqueByUrl([...thread.pullRequests ?? [], ...childPullRequests.get(thread.id) ?? []]),
    messages: [], snoozedUntil: thread.snoozedUntil ?? null, waiting: Boolean(thread.pendingRuntimeRequest), updatedAt: lastActivityAt(thread),
  }));
}

export async function readLinkedActivity(client: T3HttpClient, environmentId: string, limit: number): Promise<Activity[]> {
  const [threads, projects] = await Promise.all([listLinkedThreads(client, environmentId, { allProjects: true, includeSubagents: true }), projectTitles(client, environmentId)]);
  return busyAndRecent(threads.map((thread) => ({
    id: thread.threadId, title: thread.title, project: projects.get(thread.projectId) ?? thread.projectId,
    status: thread.status, busy: liveStatuses.includes(thread.status), updatedAt: thread.updatedAt,
    archived: false, worktree: null, model: thread.model ?? null, error: null, latestMessage: null,
  })), limit);
}

export async function readLinkedOpenWork(client: T3HttpClient, environmentId: string): Promise<OpenWork[]> {
  const [threads, projects] = await Promise.all([listLinkedThreads(client, environmentId, { allProjects: true, includeSubagents: true, settled: false }), projectTitles(client, environmentId)]);
  const byId = new Map(threads.map((thread) => [thread.threadId, thread]));
  const rootOf = (thread: LinkedThread): string => {
    const parent = thread.parentThreadId ? byId.get(thread.parentThreadId) : undefined;
    return parent ? rootOf(parent) : thread.parentThreadId ?? thread.threadId;
  };
  const childPullRequests = Map.groupBy(threads.filter((thread) => thread.parentThreadId), rootOf);
  return threads.filter((thread) => !thread.parentThreadId).map((thread) => ({
    id: thread.threadId, title: thread.title, project: projects.get(thread.projectId) ?? thread.projectId,
    status: thread.status, branch: null,
    pullRequests: uniqueByUrl([thread, ...childPullRequests.get(thread.threadId) ?? []].flatMap((member) => member.pullRequests ?? [])),
    messages: [], snoozedUntil: thread.snoozedUntil, waiting: thread.status === "waiting", updatedAt: thread.updatedAt,
  }));
}

export async function readLinkedWorkSince(client: T3HttpClient, environmentId: string, since: Date): Promise<Work[]> {
  const from = since.toISOString();
  const [threads, projects] = await Promise.all([listLinkedThreads(client, environmentId, { allProjects: true }), projectTitles(client, environmentId)]);
  const work = await Promise.all(threads.filter((thread) => !thread.parentThreadId && thread.updatedAt >= from).map(async (thread) => {
    const { branch, items } = await readLinkedMessages(client, environmentId, thread.threadId);
    return {
      id: thread.threadId, title: thread.title, project: projects.get(thread.projectId) ?? thread.projectId, status: thread.status, branch,
      pullRequests: pullRequestKeys(thread.pullRequests ?? []),
      messages: await Promise.all(items.filter((item) => item.type === "user_message" && item.createdBy === "user" && item.updatedAt >= from && item.text)
        .map(async (item) => (await readLinkedItemText(client, environmentId, thread.threadId, item))!)),
    };
  }));
  return work.filter((thread) => thread.messages.length);
}

async function readLinkedMessages(client: T3HttpClient, environmentId: string, threadId: string): Promise<{ branch: string | null; items: LinkedTimelineItem[] }> {
  const items: LinkedTimelineItem[] = [];
  let afterPosition: number | undefined;
  for (;;) {
    const page = await readLinkedThread(client, environmentId, { threadId, view: "messages", ...(afterPosition === undefined ? {} : { afterPosition }), limit: 100, maxCharsPerItem: 50_000 });
    items.push(...page.items);
    if (!page.hasMore || page.nextPosition === null) return { branch: page.thread.branch, items };
    afterPosition = page.nextPosition;
  }
}

async function projectTitles(client: T3HttpClient, environmentId: string): Promise<Map<string, string>> {
  return new Map((await listLinkedProjects(client, environmentId)).map((project) => [project.id, project.title]));
}

function busyAndRecent(threads: Activity[], limit: number): Activity[] {
  const sorted = threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return [...sorted.filter((thread) => thread.busy), ...sorted.filter((thread) => !thread.busy).slice(0, limit)];
}

function pullRequestKeys(pullRequests: ShellPullRequest[]): ShellPullRequest[] {
  return pullRequests.map(({ repository, number, url }) => ({ repository, number, url }));
}

function uniqueByUrl(pullRequests: ShellPullRequest[]): ShellPullRequest[] {
  return [...new Map(pullRequestKeys(pullRequests).map((pullRequest) => [pullRequest.url.toLowerCase(), pullRequest])).values()];
}

async function readUserMessagesSince(client: T3HttpClient, threadId: string, from: string): Promise<string[]> {
  const items = await readTurnItems(client, threadId, (oldest) => (oldest?.item.startedAt ?? "") >= from);
  return items.map(({ item }) => item)
    .filter((item) => item.type === "user_message" && item.createdBy === "user" && item.startedAt >= from && item.text)
    .map((item) => item.text!);
}

function parseRequest(args: string[]): Request {
  let local = false;
  let json = false;
  let words = false;
  let open = false;
  let host: string | undefined;
  let threadId: string | undefined;
  let limit = 20;
  let since: Date | undefined;
  const rest = [...args];
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === "--local") { local = true; continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--words") { words = true; continue; }
    if (arg === "--open") { open = true; continue; }
    if (arg === "--since") {
      since = new Date(rest.shift() ?? "");
      if (Number.isNaN(since.getTime())) throw new Error("Give --since an ISO time, such as 2026-10-09T12:00:00Z.");
      continue;
    }
    if (arg === "--limit" || arg === "--thread") {
      const value = rest.shift();
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === "--limit") {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new Error("Activity limit must be between 1 and 100.");
        limit = Number(value);
      } else {
        if (!threadIdPattern.test(value)) throw new Error("Invalid thread id.");
        threadId = value;
      }
      continue;
    }
    if (arg.startsWith("-") || host) throw new Error(usage);
    host = arg;
  }
  if (local && host) throw new Error("Choose a host or --local.");
  if ([since, threadId, open || undefined].filter(Boolean).length > 1) throw new Error("Choose one of --since, --thread, and --open.");
  if (threadId && !local && !host) throw new Error("Choose a host or --local when reading a thread.");
  if (words && !threadId) throw new Error("--words reads one thread. Add --thread.");
  const query: Query = open ? { kind: "open" } : since ? { kind: "since", since } : threadId ? { kind: "thread", threadId, words } : { kind: "recent", limit };
  return { query, host, local, json };
}

async function readLocal(client: T3HttpClient, query: Query) {
  if (query.kind === "open") return { work: await readOpenWork(client) };
  if (query.kind === "since") return { work: await readWorkSince(client, query.since) };
  if (query.kind === "thread") return query.words ? { words: await readThreadWords(client, query.threadId) } : { thread: await readThread(client, query.threadId) };
  return { threads: await readActivity(client, query.limit) };
}

async function readLinked(client: T3HttpClient, environmentId: string, query: Query) {
  if (query.kind === "open") return { work: await readLinkedOpenWork(client, environmentId) };
  if (query.kind === "since") return { work: await readLinkedWorkSince(client, environmentId, query.since) };
  if (query.kind === "thread") {
    return query.words ? { words: await readLinkedThreadWords(client, environmentId, query.threadId) } : { thread: await readLinkedThread(client, environmentId, { threadId: query.threadId }) };
  }
  return { threads: await readLinkedActivity(client, environmentId, query.limit) };
}

export async function runActivity(args: string[], io: ActivityIo): Promise<number> {
  const { query, host, local, json } = parseRequest(args);
  const reports = await withT3Session(async (client) => {
    const machines = local ? [{ host: io.host }] : await readMachines(client, io.host);
    const chosen = host ? [pickMachine(machines, host)] : machines;
    return readEachMachine<{ threads?: Activity[]; thread?: unknown; words?: ThreadWord[]; work?: Work[] }>(
      chosen, () => readLocal(client, query), (environmentId) => readLinked(client, environmentId, query),
    );
  }, { home: io.home, ...io.session });
  if (json || query.kind !== "recent") io.print(JSON.stringify(reports, null, 2));
  else for (const report of reports) printReport(report, io.print);
  return reports.some((report) => report.error) ? 1 : 0;
}

function printReport(report: ActivityReport, print: (line: string) => void): void {
  print(`${report.host}${report.error ? `: ${report.error}` : ""}`);
  if (report.error !== undefined) return;
  if (!report.threads?.length) print("  No threads.");
  for (const thread of report.threads ?? []) print(`  ${thread.busy ? "*" : " "} ${thread.status} ${thread.updatedAt} ${thread.project}: ${thread.title}\n    ${thread.id} ${thread.model ?? ""} ${thread.worktree ?? ""}`);
}
