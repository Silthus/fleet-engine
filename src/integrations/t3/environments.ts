import { randomUUID } from "node:crypto";
import type { T3Client, T3HttpClient } from "./session.ts";

export type LinkedEnvironment = {
  environmentId: string; label: string; urls: string[]; access: string;
  linkedAt: string; expiresAt: string; lastReachedAt: string | null; lastError: string | null;
  status: "reachable" | "unreachable" | "expired";
};

export type LinkedPullRequest = { host: string; repository: string; number: number; url: string; source?: string; state?: string | null };

export type LinkedThread = {
  threadId: string; projectId: string; title: string; status: string; model: string;
  parentThreadId: string | null; relationshipToParent?: "fork" | "subagent" | null; settled: boolean; snoozedUntil: string | null;
  pullRequests?: LinkedPullRequest[]; itemCount: number; createdAt: string; updatedAt: string;
};

export type LinkedThreadDetail = LinkedThread & {
  archived: boolean; pendingRequestCount: number; branch: string | null; worktreePath: string | null;
};

export type LinkedTimelineItem = {
  position: number; itemId: string; type: string; text: string | null;
  createdBy: string | null; creationSource: string | null; updatedAt: string;
  textTruncated?: boolean; nextTextOffset?: number | null;
};

export type LinkedThreadRead = { thread: LinkedThreadDetail; items: LinkedTimelineItem[]; nextPosition: number | null; hasMore: boolean };

export type LinkedThreadQuery = { allProjects?: boolean; includeSubagents?: boolean; settled?: boolean };
export type LinkedReadQuery = {
  threadId: string; view?: "messages" | "activity"; afterPosition?: number; limit?: number; maxCharsPerItem?: number; itemId?: string; textOffset?: number;
};

type ThreadPage = { threads: LinkedThread[]; nextCursor: number | null };
type ProjectPage = { projects: { id: string; title: string }[]; nextCursor: number | null };

const pageLimit = 100;
const pageSafetyLimit = 1_000;
const maxCharsPerRead = 50_000;

export async function listLinkedEnvironments(client: Pick<T3Client, "call">): Promise<LinkedEnvironment[]> {
  return (await client.call<{ links: LinkedEnvironment[] }>("peerLinks.list", {})).links;
}

export function listLinkedThreads(client: Pick<T3HttpClient, "callTool">, environmentId: string, query: LinkedThreadQuery): Promise<LinkedThread[]> {
  return pages("t3_thread_list", async (cursor) => {
    const page = await client.callTool<ThreadPage>("t3_thread_list", { environmentId, ...query, limit: pageLimit, ...(cursor ? { cursor } : {}) });
    return { items: page.threads, nextCursor: page.nextCursor };
  });
}

export function listLinkedProjects(client: Pick<T3HttpClient, "callTool">, environmentId: string): Promise<{ id: string; title: string }[]> {
  return pages("t3_project_list", async (cursor) => {
    const page = await client.callTool<ProjectPage>("t3_project_list", { environmentId, limit: pageLimit, ...(cursor ? { cursor } : {}) });
    return { items: page.projects, nextCursor: page.nextCursor };
  });
}

export function readLinkedThread(client: Pick<T3HttpClient, "callTool">, environmentId: string, query: LinkedReadQuery): Promise<LinkedThreadRead> {
  return client.callTool<LinkedThreadRead>("t3_thread_read", { environmentId, ...query });
}

export async function readLinkedItemText(client: Pick<T3HttpClient, "callTool">, environmentId: string, threadId: string, item: LinkedTimelineItem): Promise<string | null> {
  let text = item.text;
  let offset = item.textTruncated ? item.nextTextOffset ?? null : null;
  while (text !== null && offset !== null) {
    const part = (await readLinkedThread(client, environmentId, { threadId, itemId: item.itemId, textOffset: offset, maxCharsPerItem: maxCharsPerRead })).items[0];
    if (!part) throw new Error(`T3 lost item ${item.itemId} of ${threadId} while reading its text`);
    text += part.text ?? "";
    const next = part.textTruncated ? part.nextTextOffset ?? null : null;
    if (next !== null && next <= offset) throw new Error(`T3 answered item ${item.itemId} of ${threadId} with text offset ${next} again`);
    offset = next;
  }
  return text;
}

/** Every message of a thread on a linked machine, page by page. A page that does not move past the last one stops the read, so a T3 that repeats a page cannot loop it forever. */
export async function readLinkedMessages(client: Pick<T3HttpClient, "callTool">, environmentId: string, threadId: string): Promise<{ thread: LinkedThreadDetail; items: LinkedTimelineItem[] }> {
  const items: LinkedTimelineItem[] = [];
  let afterPosition: number | undefined;
  for (;;) {
    const page = await readLinkedThread(client, environmentId, { threadId, view: "messages", ...(afterPosition === undefined ? {} : { afterPosition }), limit: 100, maxCharsPerItem: 50_000 });
    items.push(...page.items);
    if (!page.hasMore || page.nextPosition === null) return { thread: page.thread, items };
    if (afterPosition !== undefined && page.nextPosition <= afterPosition) throw new Error(`T3 answered ${threadId} with position ${page.nextPosition} again`);
    afterPosition = page.nextPosition;
  }
}

export type LinkedSend = { threadId: string; messageId: string; delivery: "started" | "queued" | "steered" | "restarted" };

export async function sendLinkedMessage(client: Pick<T3HttpClient, "callTool">, environmentId: string, threadId: string, message: string): Promise<LinkedSend> {
  const sent = await client.callTool<LinkedSend>("t3_thread_send", { environmentId, threadId, message, mode: "queue", clientRequestId: `fleet-thread-send:${randomUUID()}` });
  return { threadId: sent.threadId, messageId: sent.messageId, delivery: sent.delivery };
}

async function pages<T>(tool: string, read: (cursor: number | null) => Promise<{ items: T[]; nextCursor: number | null }>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<number>();
  let cursor: number | null = null;
  for (let page = 0; page < pageSafetyLimit; page++) {
    const result = await read(cursor);
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    if (seen.has(result.nextCursor)) throw new Error(`T3 answered ${tool} with cursor ${result.nextCursor} again; stopped instead of dropping the rest of the list`);
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`T3 answered ${tool} with more than ${pageSafetyLimit} pages; stopped instead of dropping the rest of the list`);
}
