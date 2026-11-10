import {
  findThread, readLinkedThread, readThread, sendLinkedMessage, sendMessage, T3ToolError, withT3Session,
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
    const { machine, place } = await placeThread(client, io.host, threadId, host);
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
  const positional: string[] = [];
  const rest = [...args];
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg !== "--host") { positional.push(arg); continue; }
    host = rest.shift();
    if (!host) throw new Error(usage);
  }
  const [threadId, ...words] = positional;
  if (!threadId || (action === "read" && words.length)) throw new Error(usage);
  if (!threadIdPattern.test(threadId)) throw new Error("Invalid thread id.");
  return { host, threadId, words };
}

async function readMessage(words: string[], io: ThreadIo): Promise<string> {
  const text = (words.length ? words.join(" ") : await io.readStdin()).trim();
  if (!text) throw new Error("The message is empty.");
  return text;
}

async function placeThread(client: T3HttpClient, thisHost: string, threadId: string, host?: string): Promise<{ machine: string; place: Place }> {
  const machines = await readMachines(client, thisHost);
  const reports = await readEachMachine<{ place?: Place }>(
    host ? [pickMachine(machines, host)] : machines,
    async () => {
      const local = await findThread(client, threadId);
      return { place: local && !local.deletedAt ? { local } : undefined };
    },
    async (environmentId) => {
      const read = await readLinkedThread(client, environmentId, { threadId, limit: 1 }).catch((error: unknown) => {
        if (error instanceof T3ToolError && error.code === "thread_not_found") return undefined;
        throw error;
      });
      return { place: read ? { environmentId, threadId: read.thread.threadId } : undefined };
    },
  );
  const found = reports.flatMap((report) => (report.error === undefined && report.place ? [{ machine: report.host, place: report.place }] : []));
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw new Error(`Thread ${threadId} is on ${found.map((each) => each.machine).join(", ")}. Choose one with --host.`);
  const silent = reports.flatMap((report) => (report.error === undefined ? [] : [`${report.host}: ${report.error}`]));
  throw new Error([`No machine has thread ${threadId}.`, ...silent].join("\n"));
}
