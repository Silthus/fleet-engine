import { appendFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { arrivingPath, distinctIdSetting, hostSetting, projectKeySetting, sendingPath, spoolPath, type UsageLine } from "../../../src/usage/usage.ts";

export type FlushIo = { home: string; settings: Record<string, unknown>; send: typeof fetch; wait(ms: number): Promise<void>; print(line: string): void };
type Destination = { host: string; projectKey: string; distinctId: string };

const usage = "Usage: fleet usage flush  Send the spooled usage events to your analytics project";
const tries = 3;
const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

export async function usageCommand(args: string[], io: FlushIo): Promise<number> {
  if (args.length !== 1 || args[0] !== "flush") throw new Error(usage);
  const sent = await flush(io.home, destination(io.settings), io);
  io.print(`Usage events: sent ${sent}.`);
  return 0;
}

function destination(settings: Record<string, unknown>): Destination {
  if (settings[hostSetting] === undefined) throw new Error("Usage events are off. Turn them on with fleet packs --workflows usage-events=on.");
  const text = (key: string) => (typeof settings[key] === "string" ? (settings[key] as string).trim() : "");
  const host = text(hostSetting).replace(/\/+$/, "");
  const projectKey = text(projectKeySetting);
  if (!host.startsWith("https://") && !loopback.test(host)) throw new Error(`${hostSetting} must be an https:// URL. Set it with fleet set ${hostSetting}=<url>.`);
  if (!projectKey) throw new Error(`${projectKeySetting} is empty. Set it with fleet set ${projectKeySetting}=<key>.`);
  return { host, projectKey, distinctId: text(distinctIdSetting) };
}

export async function flush(home: string, to: Destination, io: Pick<FlushIo, "send" | "wait">): Promise<number> {
  const sending = sendingPath(home);
  fold(home);
  if (existsSync(spoolPath(home))) {
    renameSync(spoolPath(home), arrivingPath(home));
    fold(home);
  }
  if (!existsSync(sending)) return 0;
  const batch = readLines(readFileSync(sending, "utf8")).map((line) => ({
    event: line.event,
    timestamp: line.timestamp,
    properties: { ...line.properties, distinct_id: to.distinctId || `fleet-${line.properties.machine ?? "unknown"}`, $process_person_profile: false, $lib: "fleet" },
  }));
  if (batch.length) await post(to, JSON.stringify({ api_key: to.projectKey, batch }), io);
  rmSync(sending, { force: true });
  return batch.length;
}

/** Moves the arriving events to the end of the batch that waits to be sent. A flush that stopped after the append finds them there already and does not add them twice. */
function fold(home: string) {
  const arriving = arrivingPath(home);
  if (!existsSync(arriving)) return;
  const text = readFileSync(arriving, "utf8");
  const waiting = existsSync(sendingPath(home)) ? readFileSync(sendingPath(home), "utf8") : "";
  if (!waiting.endsWith(text)) appendFileSync(sendingPath(home), `${waiting && !waiting.endsWith("\n") ? "\n" : ""}${text}`, { mode: 0o600 });
  rmSync(arriving);
}

function readLines(text: string): UsageLine[] {
  return text.split("\n").flatMap((line) => {
    try {
      const parsed = line.trim() ? (JSON.parse(line) as UsageLine) : undefined;
      return parsed && typeof parsed.event === "string" && parsed.properties ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

async function post(to: Destination, body: string, io: Pick<FlushIo, "send" | "wait">) {
  let problem = "";
  for (let tried = 1; tried <= tries; tried++) {
    try {
      const response = await io.send(`${to.host}/batch/`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(15_000) });
      if (response.ok) return;
      problem = `answered ${response.status}`;
    } catch (error) {
      problem = `did not answer (${(error as Error).message})`;
    }
    if (tried < tries) await io.wait(tried * 1000);
  }
  throw new Error(`${to.host} ${problem} ${tries} times. The events stay in the spool for the next flush.`);
}
