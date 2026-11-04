import type { LinkedEnvironment, LinkedThread, LinkedTimelineItem, ShellThread } from "../../base/lib/t3/index.ts";
import { ToolRefusal, type ToolHandler } from "../../base/lib/t3/testing.ts";

export const now = new Date("2026-11-04T12:00:00Z");
export const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

export const linkedEnvironment: LinkedEnvironment = {
  environmentId: "env-linked", label: "devbox-2", urls: ["https://devbox-2.example.test"], access: "read-only",
  linkedAt: "2026-11-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", lastReachedAt: null, lastError: null, status: "reachable",
};

export function shellThread(id: string, fields: Partial<ShellThread> = {}): ShellThread {
  return { id, title: `Thread ${id}`, projectId: "project-local", status: "idle", createdAt: minutesAgo(600), ...fields };
}

export type LinkedThreadFixture = LinkedThread & { archived?: boolean; pendingRequestCount?: number; branch?: string | null; items?: LinkedTimelineItem[] };

export function linkedThread(threadId: string, fields: Partial<LinkedThreadFixture> = {}): LinkedThreadFixture {
  return {
    threadId, projectId: "project-linked", title: `Thread ${threadId}`, status: "idle", model: "model-a",
    parentThreadId: null, settled: false, snoozedUntil: null, pullRequests: [], itemCount: 2,
    createdAt: minutesAgo(600), updatedAt: minutesAgo(300), ...fields,
  };
}

export function linkedItem(type: string, text: string, fields: Partial<LinkedTimelineItem> = {}): LinkedTimelineItem {
  return { position: 0, itemId: `${type}-${text.length}`, type, text, createdBy: type === "user_message" ? "user" : "agent", creationSource: type === "user_message" ? "web" : "provider", updatedAt: minutesAgo(300), ...fields };
}

export function linkedTools(threads: LinkedThreadFixture[]): ToolHandler {
  return (name, args) => {
    if (args.environmentId !== linkedEnvironment.environmentId) throw new ToolRefusal("invalid_request", "unknown environment");
    if (name === "t3_project_list") return { projects: [{ id: "project-linked", title: "Linked project" }], nextCursor: null };
    if (name === "t3_thread_list") {
      const listed = threads.filter((thread) => !thread.archived && (args.includeSubagents || !thread.parentThreadId) && (args.settled === undefined || thread.settled === args.settled));
      return { projectId: null, currentThreadId: null, threads: listed.map(({ archived, pendingRequestCount, branch, items, ...item }) => item), nextCursor: null, total: listed.length };
    }
    if (name === "t3_thread_read") {
      const thread = threads.find((candidate) => candidate.threadId === args.threadId);
      if (!thread) throw new ToolRefusal("not_found", `No thread ${args.threadId}`);
      const items = (thread.items ?? []).map((item, position) => ({ ...item, position }));
      const after = typeof args.afterPosition === "number" ? args.afterPosition : -1;
      const view = args.view === "activity" ? items : items.filter((item) => ["user_message", "assistant_message"].includes(item.type));
      const page = view.filter((item) => item.position > after).slice(0, Number(args.limit ?? 50));
      const { archived, pendingRequestCount, branch, items: _, ...detail } = thread;
      return {
        thread: { ...detail, itemCount: items.length, archived: Boolean(archived), pendingRequestCount: pendingRequestCount ?? 0, branch: branch ?? null, worktreePath: null },
        recentRuns: [], items: page, nextPosition: page.at(-1)?.position ?? null, hasMore: view.some((item) => item.position > (page.at(-1)?.position ?? after)),
      };
    }
  };
}
