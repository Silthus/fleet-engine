import type { T3Client, T3HttpClient } from "./session.ts";

export type LinkedEnvironment = {
  environmentId: string; label: string; urls: string[]; access: string;
  linkedAt: string; expiresAt: string; lastReachedAt: string | null; lastError: string | null;
  status: "reachable" | "unreachable" | "expired";
};

export type LinkedPullRequest = { host: string; repository: string; number: number; url: string; source?: string; state?: string | null };

export type LinkedThread = {
  threadId: string; projectId: string; title: string; status: string; model: string;
  parentThreadId: string | null; settled: boolean; snoozedUntil: string | null;
  pullRequests?: LinkedPullRequest[]; itemCount: number; createdAt: string; updatedAt: string;
};

export type LinkedThreadDetail = LinkedThread & {
  archived: boolean; pendingRequestCount: number; branch: string | null; worktreePath: string | null;
};

export type LinkedTimelineItem = {
  position: number; itemId: string; type: string; text: string | null;
  createdBy: string | null; creationSource: string | null; updatedAt: string;
};

export type LinkedThreadRead = { thread: LinkedThreadDetail; items: LinkedTimelineItem[]; nextPosition: number | null; hasMore: boolean };

export type LinkedThreadQuery = { allProjects?: boolean; includeSubagents?: boolean; settled?: boolean };
export type LinkedReadQuery = { threadId: string; view?: "messages" | "activity"; afterPosition?: number; limit?: number; maxCharsPerItem?: number };

type ThreadPage = { threads: LinkedThread[]; nextCursor: number | null };
type ProjectPage = { projects: { id: string; title: string }[]; nextCursor: number | null };

const pageLimit = 100;
const pageCap = 20;

export async function listLinkedEnvironments(client: Pick<T3Client, "call">): Promise<LinkedEnvironment[]> {
  return (await client.call<{ links: LinkedEnvironment[] }>("peerLinks.list", {})).links;
}

export function listLinkedThreads(client: Pick<T3HttpClient, "callTool">, environmentId: string, query: LinkedThreadQuery): Promise<LinkedThread[]> {
  return pages(async (cursor) => {
    const page = await client.callTool<ThreadPage>("t3_thread_list", { environmentId, ...query, limit: pageLimit, ...(cursor ? { cursor } : {}) });
    return { items: page.threads, nextCursor: page.nextCursor };
  });
}

export function listLinkedProjects(client: Pick<T3HttpClient, "callTool">, environmentId: string): Promise<{ id: string; title: string }[]> {
  return pages(async (cursor) => {
    const page = await client.callTool<ProjectPage>("t3_project_list", { environmentId, limit: pageLimit, ...(cursor ? { cursor } : {}) });
    return { items: page.projects, nextCursor: page.nextCursor };
  });
}

export function readLinkedThread(client: Pick<T3HttpClient, "callTool">, environmentId: string, query: LinkedReadQuery): Promise<LinkedThreadRead> {
  return client.callTool<LinkedThreadRead>("t3_thread_read", { environmentId, ...query });
}

async function pages<T>(read: (cursor: number | null) => Promise<{ items: T[]; nextCursor: number | null }>): Promise<T[]> {
  const items: T[] = [];
  let cursor: number | null = null;
  for (let page = 0; page < pageCap; page++) {
    const result = await read(cursor);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === null) break;
  }
  return items;
}
