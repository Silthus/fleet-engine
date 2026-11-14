import {
  isWaiting, lastActivityAt, listLinkedThreads, matchThread, readLinkedItemText, readLinkedThread, readSnapshots, readTurnItems, T3ToolError, withT3Session,
  type LinkedReadQuery, type LinkedTimelineItem, type LinkedThread, type LinkedThreadDetail, type ShellThread, type T3HttpClient, type T3SessionOptions,
} from "../../base/lib/t3/index.ts";
import { liveStatuses, readEachMachine, readMachines } from "./machines.ts";
import {
  descendants, fetchDiscussionFromGitHub, fetchIssueFromGitHub, mapRef, parked, splitRepository, ticketType,
  type Comment, type FetchDiscussion, type FetchIssue, type MapRef, type Ticket,
} from "./wayfinder.ts";

export type LaneThread = { id: string; status: string; live: boolean; updatedAt: string; gone: boolean; waitingIn: string | null; needsHuman?: string | null };
export type BoxReport = { host: string; threads?: LaneThread[]; error?: string };
export type ReadBoxes = (threadIds: string[]) => Promise<BoxReport[]>;
export type LaneAttention = { attention: boolean; text: string };
export type LanesIo = {
  home: string; host: string; now: Date; print(line: string): void;
  fetchIssue?: FetchIssue; fetchDiscussion?: FetchDiscussion; session?: T3SessionOptions;
};

type Lane = { ticket: Ticket; threadId: string };
type TurnMessage = { type?: string; text?: string | null };

const usage = "Usage: fleet lanes <map URL | owner/repo#number> [--stall minutes]";
const dispatchMarker = "<!-- orchestration-wayfinder-dispatch -->";
const settledStatuses = ["completed", "idle"];
const defaultStallMinutes = 30;
const tailItems = 50;
export const needsHumanMarker = "NEEDS_HUMAN:";

export async function readLaneThreads(client: T3HttpClient, threadIds: string[]): Promise<LaneThread[]> {
  const threads = (await readSnapshots(client)).flatMap((snapshot) => snapshot.threads).filter((thread) => !thread.deletedAt);
  const children = Map.groupBy(threads, (thread) => thread.lineage?.parentThreadId ?? "");
  const family = (thread: ShellThread): ShellThread[] => [thread, ...(children.get(thread.id) ?? []).flatMap(family)];
  const lanes = threadIds.flatMap((id) => {
    const lane = matchThread(threads, id, (thread) => thread.id);
    return lane ? [{ id, lane, members: family(lane) }] : [];
  });
  return Promise.all(lanes.map(async ({ id, lane, members }) => {
    const live = members.filter(isLive);
    const turnDates = await Promise.all(live.map((thread) => lastTurnItemAt(client, thread.id)));
    return {
      id, status: lane.activityRunStatus ?? lane.status, live: live.length > 0,
      updatedAt: [...members.map(lastActivityAt), ...turnDates].sort().at(-1) ?? "", gone: Boolean(lane.archivedAt),
      waitingIn: members.find((thread) => thread.pendingRuntimeRequest)?.id ?? null,
      needsHuman: live.length ? null : needsHuman(finalAssistantMessage((await visibleTurnItems(client, lane.id)).map(({ item }) => item))?.text ?? ""),
    };
  }));
}

export async function readLinkedLaneThreads(client: T3HttpClient, environmentId: string, threadIds: string[]): Promise<LaneThread[]> {
  const threads = await listLinkedThreads(client, environmentId, { allProjects: true, includeSubagents: true });
  const children = Map.groupBy(threads, (thread) => thread.parentThreadId ?? "");
  const family = (thread: LinkedThread): LinkedThread[] => [thread, ...(children.get(thread.threadId) ?? []).flatMap(family)];
  const read = (query: LinkedReadQuery) => readLinkedThread(client, environmentId, query);
  const detail = async (threadId: string) => (await read({ threadId, view: "activity", limit: 1 })).thread;
  const lanes = await Promise.all(threadIds.map(async (id): Promise<LaneThread | undefined> => {
    const listed = matchThread(threads, id, (thread) => thread.threadId);
    const lane = await detail(listed?.threadId ?? id).catch(unlessNotFound);
    if (!lane) return undefined;
    const members = listed ? family(listed) : [lane];
    const live = lane.archived ? [] : members.filter((thread) => liveStatuses.includes(thread.status));
    const waitingChildren = await Promise.all(members.slice(1).filter((thread) => thread.status === "waiting").map((thread) => detail(thread.threadId)));
    return {
      id, status: lane.status, live: live.length > 0,
      updatedAt: [lane.updatedAt, ...members.map((thread) => thread.updatedAt)].sort().at(-1) ?? "", gone: lane.archived,
      waitingIn: [lane, ...waitingChildren].find((thread) => thread.pendingRequestCount > 0)?.threadId ?? null,
      needsHuman: live.length || lane.archived ? null : needsHuman(await linkedFinalText(client, environmentId, read, lane)),
    };
  }));
  return lanes.filter((lane): lane is LaneThread => Boolean(lane));
}

function unlessNotFound(error: unknown): undefined {
  if (error instanceof T3ToolError && error.code === "thread_not_found") return undefined;
  throw error;
}

async function linkedFinalText(
  client: T3HttpClient, environmentId: string, read: (query: LinkedReadQuery) => Promise<{ items: LinkedTimelineItem[] }>, lane: LinkedThreadDetail,
): Promise<string> {
  const afterPosition = lane.itemCount - tailItems - 1;
  const tail = await read({ threadId: lane.threadId, view: "activity", ...(afterPosition >= 0 ? { afterPosition } : {}), limit: tailItems, maxCharsPerItem: 50_000 });
  const final = finalAssistantMessage(tail.items);
  return final ? await readLinkedItemText(client, environmentId, lane.threadId, final) ?? "" : "";
}

async function lastTurnItemAt(client: T3HttpClient, threadId: string): Promise<string> {
  return (await visibleTurnItems(client, threadId))
    .flatMap(({ item }) => [item.startedAt, item.completedAt, item.updatedAt])
    .filter((date): date is string => Boolean(date)).sort().at(-1) ?? "";
}

function finalAssistantMessage<T extends TurnMessage>(items: T[]): T | undefined {
  const last = items.filter((item) => item.type === "user_message" || (item.type === "assistant_message" && item.text)).at(-1);
  return last?.type === "assistant_message" ? last : undefined;
}

function visibleTurnItems(client: T3HttpClient, threadId: string) {
  return readTurnItems(client, threadId, () => false).catch(() => []);
}

export function needsHuman(message: string): string | null {
  const last = message.trim().split("\n").at(-1)?.replace(/[`*]/g, "").trim() ?? "";
  return last.startsWith(needsHumanMarker) ? last.slice(needsHumanMarker.length).trim() || "no ask given" : null;
}

function isLive(thread: ShellThread): boolean {
  return Boolean(thread.activeRunId) || liveStatuses.includes(thread.activityRunStatus ?? thread.status) || isWaiting(thread, { childTasks: false });
}

export async function readLaneAttention(
  ref: MapRef, fetchIssue: FetchIssue, fetchDiscussion: FetchDiscussion, readBoxes: ReadBoxes, now: Date, stallMinutes: number,
): Promise<LaneAttention> {
  const tickets = await descendants(await fetchIssue(ref.owner, ref.repo, ref.number), fetchIssue);
  const lanes = (await Promise.all(tickets.filter(isWorking).map((ticket) => dispatchedLane(ticket, fetchDiscussion))))
    .filter((lane): lane is Lane => Boolean(lane));
  const boxes = lanes.length ? await readBoxes(lanes.map((lane) => lane.threadId)) : [];
  const findings = lanes.flatMap((lane) => {
    const finding = attentionFor(lane, boxes, now, stallMinutes);
    return finding ? [`  #${lane.ticket.number} ${ticketType(lane.ticket) ?? "ticket"} ${finding}`] : [];
  });
  const silentBoxes = boxes.filter((box) => box.error).map((box) => `${box.host} did not answer: ${box.error}`);
  const map = `${ref.owner}/${ref.repo}#${ref.number}`;
  if (!findings.length && !silentBoxes.length) return { attention: false, text: `No lane of ${map} needs attention.` };
  const heading = findings.length ? [`Lanes of ${map} that need attention:`] : [];
  return { attention: true, text: [...heading, ...findings, ...silentBoxes].join("\n") };
}

function isWorking(ticket: Ticket): boolean {
  return ticket.state === "OPEN" && ticket.assignees.length > 0 && !ticket.labels.includes(parked);
}

async function dispatchedLane(ticket: Ticket, fetchDiscussion: FetchDiscussion): Promise<Lane | undefined> {
  const [owner, repo] = splitRepository(ticket.repository);
  const { comments } = await fetchDiscussion(owner, repo, ticket.number);
  const threadId = comments.map(locatorThread).filter(Boolean).at(-1);
  return threadId ? { ticket, threadId } : undefined;
}

function locatorThread(comment: Comment): string | undefined {
  if (!comment.body.includes(dispatchMarker)) return undefined;
  return comment.body.match(/^(?:Child thread|Thread):\s*`?([a-zA-Z0-9][a-zA-Z0-9:._%-]{0,511})`?\s*$/m)?.[1];
}

function attentionFor(lane: Lane, boxes: BoxReport[], now: Date, stallMinutes: number): string | undefined {
  const found = boxes.flatMap((box) => (box.threads ?? []).filter((thread) => thread.id === lane.threadId).map((thread) => ({ box, thread })))[0];
  const orphaned = "Reconcile the ticket as an orphaned lane.";
  if (!found) return boxes.some((box) => box.error) ? undefined : `gone: no box has its thread ${lane.threadId}. ${orphaned}`;
  const { box, thread } = found;
  const where = `Thread ${thread.id} on ${box.host}.`;
  if (thread.gone) return `gone: its thread is archived or deleted. ${orphaned} ${where}`;
  if (thread.waitingIn) return `blocked: waits on an approval or an answer nobody sees in thread ${thread.waitingIn}. ${where}`;
  if (thread.needsHuman) return `needs the human: ${thread.needsHuman}. Ask them with the question tool, then send the answer to its thread. ${where}`;
  if (thread.live) {
    const quietMinutes = Math.floor((now.getTime() - Date.parse(thread.updatedAt)) / 60_000);
    return quietMinutes > stallMinutes
      ? `stalled: running with no activity for ${quietMinutes}m. Read its thread, and stop it when it is past its cap. ${where}`
      : undefined;
  }
  if (ticketType(lane.ticket) === "grilling") return undefined;
  const status = settledStatuses.includes(thread.status) ? "" : ` T3 shows ${thread.status}; the ticket decides.`;
  return `finished: ended its turn with the ticket open. Read its result and act on it.${status} ${where}`;
}

export async function runLanes(args: string[], io: LanesIo): Promise<number> {
  const [map, flag, minutes, ...rest] = args;
  if (!map || rest.length || (flag && (flag !== "--stall" || !/^\d+$/.test(minutes ?? "")))) throw new Error(usage);
  const ref = mapRef(map, usage);
  const readBoxes: ReadBoxes = (threadIds) => withT3Session(async (client) => readEachMachine(
    await readMachines(client, io.host),
    async () => ({ threads: await readLaneThreads(client, threadIds) }),
    async (environmentId) => ({ threads: await readLinkedLaneThreads(client, environmentId, threadIds) }),
  ), { home: io.home, ...io.session });
  const report = await readLaneAttention(ref, io.fetchIssue ?? fetchIssueFromGitHub, io.fetchDiscussion ?? fetchDiscussionFromGitHub, readBoxes, io.now, Number(minutes ?? defaultStallMinutes));
  io.print(report.text);
  return report.attention ? 1 : 0;
}
