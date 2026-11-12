import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readLinkedItemText, readLinkedMessages, type LinkedTimelineItem } from "./environments.ts";
import { t3StatePath, t3UserData } from "./server.ts";
import type { T3Client, T3HttpClient } from "./session.ts";

export type ShellPullRequest = { repository: string; number: number; url: string; snapshot?: { state?: string } | null };

export type ShellThread = {
  id: string; title: string; projectId: string; status: string;
  activeRunId?: string | null; activityRunStatus?: string | null; pendingBackgroundTasks?: { kind: string; childThreadId?: string }[];
  createdAt?: string; latestUserMessageAt?: string | null; latestRunRequestedAt?: string | null;
  latestRunStartedAt?: string | null; latestRunCompletedAt?: string | null;
  archivedAt?: string | null; deletedAt?: string | null; settledAt?: string | null; snoozedUntil?: string | null; worktreePath?: string | null;
  modelSelection?: { model: string }; lastError?: string | null;
  pendingRuntimeRequest?: unknown; latestVisibleMessage?: { updatedAt: string; text: string } | null;
  branch?: string | null; latestUserAuthoredMessageAt?: string | null;
  lineage?: { parentThreadId?: string | null; rootThreadId?: string | null }; pullRequests?: ShellPullRequest[];
};

export type ShellProject = { id: string; title: string; workspaceRoot: string };
export type ShellSnapshot = { projects: ShellProject[]; threads: ShellThread[] };

type QuestionAnswer = { questionTextById: Record<string, string>; answers: Record<string, string | string[]> };
export type TurnItem = {
  item: {
    id?: string; type: string; createdBy?: string; creationSource?: string; messageId?: string; text?: string;
    startedAt: string; completedAt?: string | null; updatedAt?: string | null; requestId?: string; questionAnswer?: QuestionAnswer;
  };
};
type BoundedThread = { projection: { visibleTurnItems: TurnItem[] }; historyCursor: string | null; hasMoreHistory: boolean };
type HistoryPage = { items: TurnItem[]; nextCursor: string | null; hasMoreHistory: boolean };

export type ThreadWord = { thread: string; id: string; text: string; answered: string; at: string; source: "question" | "typed" };

export function readSnapshots(client: T3Client): Promise<[ShellSnapshot, ShellSnapshot]> {
  return Promise.all([client.getShell<ShellSnapshot>(), client.call<ShellSnapshot>("orchestration.getArchivedShellSnapshot", {})]);
}

export function matchThread<T>(threads: T[], value: string, id: (thread: T) => string): T | undefined {
  return threads.find((thread) => id(thread) === value) ?? threads.find((thread) => id(thread).endsWith(`:${value}`));
}

export async function findThread(client: T3Client, value: string): Promise<ShellThread | undefined> {
  return matchThread((await readSnapshots(client)).flatMap((snapshot) => snapshot.threads), value, (thread) => thread.id);
}

async function resolveThreadId(client: T3Client, value: string): Promise<string> {
  const thread = await findThread(client, value);
  if (!thread) throw new Error(`No thread ${value} on this machine; ids look like mcp:<uuid>`);
  return thread.id;
}

export async function readThread(client: T3Client, value: string): Promise<unknown> {
  return client.call("orchestration.getThreadProjection", { threadId: await resolveThreadId(client, value) });
}

export type SentMessage = { threadId: string; messageId: string; delivery: "queued" | "started" };

export async function sendMessage(client: T3Client, thread: ShellThread, text: string): Promise<SentMessage> {
  if (thread.archivedAt) throw new Error(`Thread ${thread.id} is archived. Unarchive it before you send it a message.`);
  const messageId = `fleet-thread-send:${randomUUID()}`;
  const delivery = thread.activeRunId ? "queued" : "started";
  await client.call("orchestration.dispatchCommand", {
    type: "message.dispatch", commandId: messageId, messageId, threadId: thread.id, text, attachments: [],
    dispatchMode: { type: delivery === "queued" ? "queue_after_active" : "start_immediately" },
    createdBy: "agent", creationSource: "server",
  });
  return { threadId: thread.id, messageId, delivery };
}

export function lastActivityAt(thread: ShellThread): string {
  return [thread.createdAt, thread.latestUserMessageAt, thread.latestRunRequestedAt, thread.latestRunStartedAt, thread.latestRunCompletedAt, thread.latestVisibleMessage?.updatedAt]
    .filter((date): date is string => Boolean(date)).sort().at(-1) ?? "";
}

export async function readTurnItems(client: Pick<T3HttpClient, "get">, threadId: string, keepPaging: (oldest: TurnItem | undefined) => boolean): Promise<TurnItem[]> {
  const path = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
  const bounded = await client.get<BoundedThread>(`${path}/bounded`);
  let items = bounded.projection.visibleTurnItems;
  let cursor = bounded.hasMoreHistory ? bounded.historyCursor : null;
  while (cursor && keepPaging(items[0])) {
    const page = await client.get<HistoryPage>(`${path}/history?cursor=${encodeURIComponent(cursor)}`);
    items = [...page.items, ...items];
    cursor = page.hasMoreHistory ? page.nextCursor : null;
  }
  return items;
}

const answeredCap = 1000;
const typedByUser = (item: TurnItem["item"]) => item.type === "user_message" && item.createdBy === "user" && ["web", "mobile"].includes(item.creationSource ?? "");

export async function readThreadWords(client: T3HttpClient, value: string, statePath = t3StatePath(t3UserData(homedir()))): Promise<ThreadWord[]> {
  const threadId = await resolveThreadId(client, value);
  const items = await readTurnItems(client, threadId, () => true);
  const answeredInClient = questionsAnsweredInClient(statePath, threadId);
  const words: ThreadWord[] = [];
  let lastAssistant = "";
  for (const { item } of items) {
    if (item.type === "assistant_message" && item.text) lastAssistant = item.text;
    if (typedByUser(item) && item.text) words.push({ thread: threadId, id: item.messageId ?? item.id ?? "", text: item.text, answered: lastAssistant.slice(0, answeredCap), at: item.updatedAt ?? item.startedAt, source: "typed" });
    const answer = item.type === "user_input_request" && answeredInClient().has(item.requestId ?? "") ? item.questionAnswer : undefined;
    Object.entries(answer?.answers ?? {}).forEach(([question, text], index) => words.push({
      thread: threadId, id: `${item.id}:${index}`, text: [text].flat().join(", "), answered: (answer!.questionTextById[question] ?? question).slice(0, answeredCap), at: item.updatedAt ?? item.startedAt, source: "question",
    }));
  }
  return words;
}

export async function readLinkedThreadWords(client: Pick<T3HttpClient, "callTool">, environmentId: string, threadId: string): Promise<ThreadWord[]> {
  const words: ThreadWord[] = [];
  let lastAssistant = "";
  for (const item of (await readLinkedMessages(client, environmentId, threadId)).items) {
    if (item.type === "assistant_message" && item.text) lastAssistant = item.text;
    if (typedByUserRemotely(item) && item.text) {
      words.push({ thread: threadId, id: item.itemId, text: (await readLinkedItemText(client, environmentId, threadId, item))!, answered: lastAssistant.slice(0, answeredCap), at: item.updatedAt, source: "typed" });
    }
  }
  return words;
}

const typedByUserRemotely = (item: LinkedTimelineItem) => item.type === "user_message" && item.createdBy === "user" && ["web", "mobile"].includes(item.creationSource ?? "");

const clientCommand = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function questionsAnsweredInClient(statePath: string, threadId: string) {
  let answered: Set<string> | undefined;
  return () => answered ??= readAnsweringCommands(statePath, threadId);
}

function readAnsweringCommands(statePath: string, threadId: string): Set<string> {
  let db: Database;
  try { db = new Database(statePath, { readonly: true }); }
  catch (error) { throw new Error(`Cannot read T3's event store at ${statePath} to tell who answered a question (${(error as Error).message})`); }
  try {
    const resolutions = db.query(`select json_extract(payload_json, '$.id') request, command_id command from orchestration_events
      where aggregate_kind = 'thread' and stream_id = ? and event_type = 'runtime-request.updated'
        and json_extract(payload_json, '$.status') = 'resolved' and json_extract(payload_json, '$.answers') is not null
      order by sequence`).all(threadId) as { request: string; command: string | null }[];
    const first = new Map<string, string | null>();
    for (const { request, command } of resolutions) if (!first.has(request)) first.set(request, command);
    return new Set([...first].filter(([, command]) => clientCommand.test(command ?? "")).map(([request]) => request));
  } catch (error) {
    throw new Error(`Cannot read who answered the questions of ${threadId} in ${statePath} (${(error as Error).message})`);
  } finally { db.close(); }
}
