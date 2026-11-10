import {
  listLinkedThreads, readLinkedThread, readSnapshots, readThread, sendLinkedMessage, sendMessage, T3ToolError, withT3Session,
  type ShellThread, type T3HttpClient, type T3SessionOptions,
} from "../../base/lib/t3/index.ts";
import { runActivity } from "./activity.ts";
import { pickMachine, readEachMachine, readMachines } from "./machines.ts";

export type ThreadIo = { home: string; host: string; print(line: string): void; readStdin(): Promise<string>; session?: T3SessionOptions };

type Place = { local: ShellThread } | { environmentId: string; threadId: string };

const usage = `Usage: fleet thread list [host] [--limit count] [--json]
       fleet thread read [--host host] <id>
       fleet thread send [--host host] <id> [message]
Without --host, Fleet finds the machine that has the thread. The message comes from stdin when you leave it out.`;
const threadIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9:._%-]{0,511}$/;
const sendScopes = ["orchestration:read", "orchestration:operate", "access:read"];

export async function runThread(args: string[], io: ThreadIo): Promise<number> {
  const [action, ...rest] = args;
  if (action === "list") return runActivity(rest, io);
  if (action !== "read" && action !== "send") throw new Error(usage);
  const { host, threadId, words } = parseTarget(rest, action);
  const text = action === "send" ? await readMessage(words, io) : "";
  const result = await withT3Session(async (client) => {
    const { machine, place } = await placeThread(client, io.host, threadId, host, action);
    if (action === "read") {
      return { host: machine, thread: "local" in place ? await readThread(client, place.local.id) : await readLinkedThread(client, place.environmentId, { threadId: place.threadId }) };
    }
    return { host: machine, ...("local" in place ? await sendMessage(client, place.local, text) : await sendLinkedMessage(client, place.environmentId, place.threadId, text)) };
  }, { home: io.home, ...io.session, ...(action === "send" ? { scopes: sendScopes } : {}) });
  io.print(JSON.stringify(result, null, 2));
  return 0;
}

function parseTarget(args: string[], action: "read" | "send") {
  let host: string | undefined;
  const rest = [...args];
  while (rest[0] === "--host") {
    rest.shift();
    host = rest.shift();
    if (!host) throw new Error(usage);
  }
  const [threadId, ...words] = rest;
  if (!threadId || threadId.startsWith("-") || (action === "read" && words.length)) throw new Error(usage);
  if (!threadIdPattern.test(threadId)) throw new Error("Invalid thread id.");
  return { host, threadId, words };
}

async function readMessage(words: string[], io: ThreadIo): Promise<string> {
  const text = (words.length ? words.join(" ") : await io.readStdin()).trim();
  if (!text) throw new Error("The message is empty.");
  return text;
}

async function placeThread(client: T3HttpClient, thisHost: string, value: string, host: string | undefined, action: "read" | "send"): Promise<{ machine: string; place: Place }> {
  const machines = await readMachines(client, thisHost);
  const reports = await readEachMachine<{ ids: string[]; locals?: ShellThread[]; environmentId?: string }>(
    host ? [pickMachine(machines, host)] : machines,
    async () => {
      const locals = (await readSnapshots(client)).flatMap((snapshot) => snapshot.threads).filter((thread) => !thread.deletedAt);
      return { ids: locals.map((thread) => thread.id), locals };
    },
    async (environmentId) => {
      const ids = (await listLinkedThreads(client, environmentId, { allProjects: true, includeSubagents: true })).map((thread) => thread.threadId);
      if (ids.includes(value)) return { ids, environmentId };
      const exact = await readLinkedThread(client, environmentId, { threadId: value, limit: 1 }).catch((error: unknown) => {
        if (error instanceof T3ToolError && error.code === "thread_not_found") return undefined;
        throw error;
      });
      return { ids: exact ? [exact.thread.threadId] : ids, environmentId };
    },
  );
  const found = reports.flatMap((report) => {
    if (report.error !== undefined) return [];
    const id = pickId(report.ids, value, report.host);
    if (!id) return [];
    const place: Place = report.environmentId ? { environmentId: report.environmentId, threadId: id } : { local: report.locals!.find((thread) => thread.id === id)! };
    return [{ machine: report.host, place }];
  });
  const silent = reports.flatMap((report) => (report.error === undefined ? [] : [`${report.host} could not be checked (${report.error})`]));
  if (found.length > 1) throw new Error(`Thread ${value} is on ${found.map((each) => each.machine).join(", ")}. Choose one with --host.`);
  if (found.length === 1 && action === "send" && !host && silent.length) {
    throw new Error(`Thread ${value} is on ${found[0]!.machine}, but ${silent.join("; ")}. Choose the machine with --host.`);
  }
  if (found.length === 1) return found[0]!;
  throw new Error([`No machine has thread ${value}.`, ...reports.flatMap((report) => (report.error === undefined ? [] : [`${report.host}: ${report.error}`]))].join("\n"));
}

function pickId(ids: string[], value: string, machine: string): string | undefined {
  if (ids.includes(value)) return value;
  const fits = ids.filter((id) => id.endsWith(`:${value}`));
  if (fits.length > 1) throw new Error(`On ${machine}, ${value} fits ${fits.join(", ")}. Give the full id.`);
  return fits[0];
}
