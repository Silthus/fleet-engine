import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export const whys = ["intake", "failed-check", "expired", "revoked", "scope", "missed"] as const;
export type Why = (typeof whys)[number];

export type CheckResult = { ok: true; unchecked?: string } | { ok: false; reason: string };
export type Provider = { name: string; check?: (values: Record<string, string>) => Promise<CheckResult> };
export type SecretFile = { path: string; format: "value" | "env" | "json"; fields?: Record<string, string>; renew: string };
export type SecretRow = { name: string; provider: Provider; scope: string; project?: string; region?: string; settings: string; env: string[]; file?: SecretFile };

export type PutEvent = {
  type: "put"; id: string; name: string; at: string; why: Why;
  expiresAt?: string; storeExpiresAt?: string; thread?: string; machine: string; unchecked?: string;
  lane?: string; env?: string; revoke?: string;
};
export type LanePut = PutEvent & { lane: string; env: string };
export type OffEvent = { type: "off"; id: string; reason: string; at: string; thread?: string; machine: string };
export type SecretEvent =
  | PutEvent
  | { type: "read"; id?: string; name: string; at: string; thread?: string; machine: string; refused?: string; check?: true }
  | { type: "drop"; id?: string; name: string; lane: string; put: string; at: string }
  | OffEvent
  | { type: "on"; off: string; words: string; thread: string; message: string; at: string };

export const secretFilesDir = (home: string) => join(home, ".t3/userdata/secrets/files");
export const valuesDir = (home: string) => join(home, ".config/fleet/secrets");
export const eventLogPath = (home: string) => join(home, ".local/state/fleet/secrets.jsonl");

export class SecretRefusal extends Error {}

function synced(path: string, flag: string, write: (file: number) => void, mode = 0o600) {
  const file = openSync(path, flag, mode);
  try {
    write(file);
    fsyncSync(file);
  } finally { closeSync(file); }
}

const syncDir = (dir: string) => synced(dir, "r", () => undefined);

function madeDir(dir: string) {
  const missing: string[] = [];
  for (let at = dir; !existsSync(at); at = dirname(at)) missing.push(at);
  if (!missing.length) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const created of missing) syncDir(dirname(created));
  return true;
}

export type WriteBytes = (file: number, bytes: Uint8Array, offset: number) => number;
const diskWrite: WriteBytes = (file, bytes, offset) => writeSync(file, bytes, offset);

function writeAll(write: WriteBytes, file: number, text: string) {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length;) {
    const written = write(file, bytes, at);
    if (!(written > 0)) throw new Error("a write to the store made no progress");
    at += written;
  }
}

export function writeNewFile(path: string, data: string, write = diskWrite) {
  madeDir(dirname(path));
  synced(path, "wx", (file) => writeAll(write, file, data));
  syncDir(dirname(path));
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const shapes: Record<SecretEvent["type"], (event: Record<string, unknown>) => boolean> = {
  put: (event) => isText(event.id) && isText(event.name) && isText(event.at) && (whys as readonly unknown[]).includes(event.why),
  drop: (event) => isText(event.name) && isText(event.lane) && isText(event.put) && isText(event.at),
  read: (event) => isText(event.name) && isText(event.at),
  off: (event) => isText(event.id) && isText(event.reason) && isText(event.at),
  on: (event) => isText(event.off) && isText(event.words) && isText(event.thread) && isText(event.message) && isText(event.at),
};

export const damagedReason = "a damaged line in the event log, which may be a torn off";
const damagedPrefix = "damaged-";

function parsed(line: string): Record<string, unknown> | undefined {
  try {
    const event = JSON.parse(line) as unknown;
    return event && typeof event === "object" && !Array.isArray(event) ? event as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function readEvents(home: string): SecretEvent[] {
  let text: string;
  try { text = readFileSync(eventLogPath(home), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const events: SecretEvent[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const event = parsed(line);
    const known = event && shapes[event.type as SecretEvent["type"]];
    if (known && known(event)) events.push(event as SecretEvent);
    else if (line.trim() && (!event || event.type === "off")) events.push({ type: "off", id: `${damagedPrefix}${offset}`, reason: damagedReason, at: events.at(-1)?.at ?? new Date(0).toISOString(), machine: "unknown" });
    offset += Buffer.byteLength(line) + 1;
  }
  return events;
}

export type AppendLog = (path: string, text: string, write?: WriteBytes) => void;
export const appendToLog: AppendLog = (path, text, write = diskWrite) => synced(path, "a", (file) => writeAll(write, file, text));
type LogStore = { home: string; appendLog?: AppendLog; write?: WriteBytes };

export function appendEvents(store: LogStore, ...events: SecretEvent[]) {
  const path = eventLogPath(store.home);
  const fresh = madeDir(dirname(path)) || !existsSync(path);
  (store.appendLog ?? appendToLog)(path, `\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`, store.write);
  if (fresh) syncDir(dirname(path));
}

export const heardKey = ({ thread, message }: { thread: string; message: string }) => `${thread}/${message}`;

export function fold(events: SecretEvent[]) {
  const puts = new Map<string, PutEvent>();
  let off: OffEvent | undefined;
  const heard = new Set<string>();
  for (const event of events) {
    if (event.type === "put") { if (!heldByOtherLane(puts.get(event.name), event)) puts.set(event.name, event); }
    else if (event.type === "drop") { if (puts.get(event.name)?.id === event.put) puts.delete(event.name); }
    else if (event.type === "off") off = event;
    else if (event.type === "on") { if (event.off === off?.id) off = undefined; heard.add(heardKey(event)); }
  }
  return { puts, off, heard };
}

const heldByOtherLane = (held: PutEvent | undefined, put: { lane?: string; at: string }) =>
  !!put.lane && !!held?.lane && held.lane !== put.lane && !!held.storeExpiresAt && Date.parse(held.storeExpiresAt) > Date.parse(put.at);

export type Store = LogStore & { rows: SecretRow[]; now: Date };

function switchState(store: Store) {
  const state = fold(readEvents(store.home));
  if (!state.off?.id.startsWith(damagedPrefix)) return state;
  appendEvents(store, { type: "off", id: newId("o"), reason: `${damagedReason}, found at byte ${state.off.id.slice(damagedPrefix.length)}`, at: store.now.toISOString(), machine: "hub" });
  return fold(readEvents(store.home));
}
const dayMs = 24 * 60 * 60 * 1000;
export const standingDays = 90;
export const minimumLength = 8;
export const dueDays = 7;
export const laneDays = 7;
export const laneDueDays = 1;

const rowOf = ({ rows }: Store, name: string) => rows.find((row) => row.name === name);
export const isLane = (put: PutEvent | undefined): put is LanePut => !!put?.lane && !!put.env;
const laneRow = (put: { name: string; lane: string; env: string; revoke?: string }): SecretRow => ({ name: put.name, provider: { name: "lane" }, scope: `lane ${put.lane}`, settings: put.revoke ?? "", env: [put.env] });
const rowFor = (store: Store, name: string, put: PutEvent | undefined) => rowOf(store, name) ?? (isLane(put) ? laneRow(put) : undefined);
const valuePath = (home: string, put: PutEvent) => join(valuesDir(home), `${put.name}.${put.id}`);
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

function fieldsOf(row: SecretRow, text: string): Record<string, string> {
  const body = text.replace(/\r?\n$/, "");
  const lines = body.split(/\r?\n/);
  if (/\r/.test(body) || (row.env.length === 1 && lines.length > 1)) throw new SecretRefusal(`A ${row.name} value is one line; this file holds a line break. Nothing was stored`);
  const fields: Record<string, string> = {};
  if (row.env.length === 1 && !lines[0]!.startsWith(`${row.env[0]}=`)) fields[row.env[0]!] = lines[0]!;
  else for (const line of lines) {
    const cut = line.indexOf("=");
    const key = cut > 0 ? line.slice(0, cut) : "";
    if (!row.env.includes(key) || key in fields) throw new SecretRefusal(`A ${row.name} file holds one ${row.env.join("=…, one ")}=… line each, and nothing else. Nothing was stored`);
    fields[key] = line.slice(cut + 1);
  }
  const missing = row.env.filter((key) => !fields[key]);
  if (missing.length) throw new SecretRefusal(`The ${row.name} file has no value for ${missing.join(", ")}. Nothing was stored`);
  const nulled = row.env.filter((key) => fields[key]!.includes("\u0000"));
  if (nulled.length) throw new SecretRefusal(`The ${row.name} value of ${nulled.join(", ")} holds a null character, which no environment variable can carry. Nothing was stored`);
  const short = row.env.filter((key) => fields[key]!.length < minimumLength);
  if (short.length) throw new SecretRefusal(`The ${row.name} value of ${short.join(", ")} is shorter than ${minimumLength} characters, too short to redact from output safely. Nothing was stored`);
  return fields;
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

function timeOf(text: string) {
  const parts = datePattern.exec(text);
  if (!parts) return NaN;
  const [year, month, day, hour = 0, minute = 0, second = 0] = parts.slice(1, 7).map((part) => Number(part ?? 0));
  const calendar = new Date(Date.UTC(2000, month! - 1, day!));
  calendar.setUTCFullYear(year!);
  if (calendar.toISOString().slice(0, 10) !== text.slice(0, 10) || hour > 23 || minute > 59 || second > 59) return NaN;
  return Date.parse(parts[4] === undefined ? `${text}T00:00:00Z` : text);
}

export function expiryOf(text: string | undefined, now: Date, days: number) {
  if (text === undefined) return undefined;
  const time = timeOf(text);
  if (!Number.isFinite(time)) throw new SecretRefusal(`--expires takes a real date such as 2026-12-31, or a time with its zone such as 2026-12-31T18:00Z, not ${text}`);
  if (time <= now.getTime()) throw new SecretRefusal(`--expires ${text} is past. Nothing was stored`);
  if (time > now.getTime() + days * dayMs) throw new SecretRefusal(`--expires ${text} is more than ${days} days out: ${days === laneDays ? "a lane secret lives" : "a standing secret is rotated"} within ${days} days. Ask for a key that expires sooner`);
  return time;
}

export type LaneInput = { key: string; env: string; revoke?: string };
export type PutInput = { name: string; text: string; expires?: string; why: Why; thread?: string; machine: string; lane?: LaneInput };

export const showsValue = (text: string, values: string[]) => values.some((value) => value.length >= 3 && text.includes(value));
export const unshown = (texts: string[], values: string[]) => texts.find((text) => !showsValue(text, values)) ?? "✗";
const hiddenValue = "Refused, and the reason would show part of the value. Nothing was stored";

export const olderHub = (op: string) => `the hub runs an older fleet secret that has no ${op}, so nothing was done there. Run fleet update on the hub`;

export function failureOf(error: unknown) {
  if (error instanceof SecretRefusal) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return `The store failed${typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? ` (${code})` : ""}; its message is not shown, as it could hold a value`;
}

async function checkOf(provider: Provider, values: Record<string, string>): Promise<CheckResult> {
  try { return provider.check ? await provider.check(values) : { ok: true, unchecked: "its provider has no check" }; }
  catch { return { ok: false, reason: "the check failed with an error it does not show" }; }
}

export const piecesOf = (text: string) => text.split(/\r?\n/).flatMap((line) => line.includes("=") ? [line, line.slice(line.indexOf("=") + 1)] : [line]);

export async function putValue(store: Store, input: PutInput): Promise<PutEvent> {
  try {
    const row = input.lane ? laneRowFor(store, input.name, input.lane) : rowOf(store, input.name);
    if (!row || row.file) throw new SecretRefusal(`No declared secret ${input.name} is kept by the store. fleet secret list shows the names`);
    return await checkAndStore(store, row, input);
  } catch (error) {
    throw new SecretRefusal(unshown([error instanceof SecretRefusal ? error.message : `${failureOf(error)}. Nothing was stored`, hiddenValue, "Refused"], piecesOf(input.text)));
  }
}

const heldRefusal = (name: string, lane: string) => new SecretRefusal(`${name} is held by lane ${lane}; pick another name. Nothing was stored`);

function laneRowFor(store: Store, name: string, lane: LaneInput): SecretRow {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new SecretRefusal(`A lane secret's name is lowercase letters, digits and hyphens, not ${name}`);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(lane.env)) throw new SecretRefusal(`--env takes a variable name such as API_KEY, not ${lane.env}`);
  if (!/^\S+$/.test(lane.key)) throw new SecretRefusal("--lane takes the lane key: the stack ticket (owner/repo#n), or the thread id of a lane started on its own");
  if (lane.revoke !== undefined && !/^https:\/\/\S+$/.test(lane.revoke)) throw new SecretRefusal("--revoke takes the https link where the user revokes the secret");
  if (rowOf(store, name)) throw new SecretRefusal(`${name} is a declared secret; a lane puts its own names. Nothing was stored`);
  const held = fold(readEvents(store.home)).puts.get(name);
  if (heldByOtherLane(held, { lane: lane.key, at: store.now.toISOString() })) throw heldRefusal(name, held!.lane!);
  return laneRow({ name, lane: lane.key, env: lane.env, ...lane.revoke ? { revoke: lane.revoke } : {} });
}

async function checkAndStore(store: Store, row: SecretRow, input: PutInput): Promise<PutEvent> {
  const fields = fieldsOf(row, input.text);
  const days = input.lane ? laneDays : standingDays;
  const expires = expiryOf(input.expires, store.now, days);
  const checked = await checkOf(row.provider, fields);
  if (!checked.ok) throw new SecretRefusal(`The ${row.provider.name} check refused the new ${row.name} value: ${checked.reason}. The stored value stays`);
  const storeExpires = Math.min(expires ?? Infinity, store.now.getTime() + days * dayMs);
  const event: PutEvent = {
    type: "put", id: newId("p"), name: row.name, at: store.now.toISOString(), why: input.why,
    ...expires === undefined ? {} : { expiresAt: new Date(expires).toISOString() }, storeExpiresAt: new Date(storeExpires).toISOString(),
    ...input.thread ? { thread: input.thread } : {}, machine: input.machine, ...checked.unchecked ? { unchecked: checked.unchecked } : {},
    ...input.lane ? { lane: input.lane.key, env: input.lane.env, ...input.lane.revoke ? { revoke: input.lane.revoke } : {} } : {},
  };
  const logged = readEvents(store.home).flatMap((logged) => [JSON.stringify(logged), ...stringsOf(logged)]);
  const shown = [JSON.stringify(event), ...stringsOf(event), ...printedLines(store, row, event), ...logged].join("\n");
  if (showsValue(shown, Object.values(fields))) throw new SecretRefusal(hiddenValue);
  if (showsValue([JSON.stringify(event), ...stringsOf(event)].join("\n"), storedValues(store.home))) throw new SecretRefusal(`The ${row.name} put's name, lane or links would show a value the store holds. Nothing was stored`);
  writeNewFile(valuePath(store.home, event), row.env.map((key) => `${key}=${fields[key]}\n`).join(""), store.write);
  appendEvents(store, event);
  const events = readEvents(store.home);
  const at = landed(events, event);
  if (at < 0) throw new SecretRefusal(`The ${row.name} put's event did not land whole in the event log, so it was not stored, and the torn line keeps the store off. Only the user's words turn it on: fleet secret on`);
  const owner = fold(events.slice(0, at + 1)).puts.get(row.name);
  if (owner?.id !== event.id) {
    removeValue(store.home, event);
    throw heldRefusal(row.name, owner?.lane ?? "another lane");
  }
  return event;
}

function parseValues(text: string) {
  return Object.fromEntries(text.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

function parseEnvFile(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trimStart().startsWith("#")) values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

type FileRow = SecretRow & { file: SecretFile };

function fileValues(home: string, row: FileRow): Record<string, string> | string {
  const path = join(home, row.file.path);
  let info;
  try { info = lstatSync(path); } catch { return "missing"; }
  if (!info.isFile() || (info.mode & 0o077) !== 0) return `~/${row.file.path} must be a regular file readable only by its owner (chmod 600)`;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return `~/${row.file.path} could not be read`; }
  let source: Record<string, unknown>;
  if (row.file.format === "value") source = { [row.env[0]!]: text.replace(/\r?\n$/, "") };
  else if (row.file.format === "env") source = parseEnvFile(text);
  else {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return `~/${row.file.path} is not JSON`; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return `~/${row.file.path} holds no JSON object`;
    source = parsed as Record<string, unknown>;
  }
  const held = Object.values(source).filter((value): value is string => typeof value === "string");
  const refuse = (reason: string) => unshown([reason, `~/${row.file.path} is unusable, and the reason would show part of a value it holds`, "unusable"], held);
  const fields = row.file.fields ?? Object.fromEntries(row.env.map((key) => [key, key]));
  const values: Record<string, string> = {};
  for (const [key, variable] of Object.entries(fields)) {
    const value = source[key];
    if (typeof value !== "string" || !value) return refuse(`missing ${key} in ~/${row.file.path}`);
    if (value.includes("\u0000")) return refuse(`${key} in ~/${row.file.path} holds a null character, so run could not pass it`);
    if (/[\r\n]/.test(value)) return refuse(`${key} in ~/${row.file.path} holds a line break, so run could not redact it`);
    if (value.length < minimumLength) return refuse(`${key} in ~/${row.file.path} is shorter than ${minimumLength} characters, so run could not redact it`);
    values[variable] = value;
  }
  return values;
}

function fileState(home: string, row: FileRow): string | undefined {
  let info;
  try { info = lstatSync(join(home, row.file.path)); } catch { return "missing"; }
  if (!info.isFile()) return "not a regular file";
  return (info.mode & 0o077) !== 0 ? "readable by others (chmod 600)" : undefined;
}

const isFileRow = (row: SecretRow): row is FileRow => row.file !== undefined;

function currentValues(store: Store, row: SecretRow, put: PutEvent | undefined): Record<string, string> | string {
  if (isFileRow(row)) return fileValues(store.home, row);
  if (!put) return "missing";
  if (put.storeExpiresAt && Date.parse(put.storeExpiresAt) <= store.now.getTime()) return `past its store expiry ${put.storeExpiresAt.slice(0, 10)}`;
  let values: Record<string, string>;
  try { values = parseValues(readFileSync(valuePath(store.home, put), "utf8")); }
  catch { return "missing its value file"; }
  const stored = Object.keys(values);
  if (stored.length !== row.env.length || row.env.some((key) => !values[key])) return `stored for ${stored.join(" ")}, but its row now sets ${row.env.join(" ")}; put it again`;
  return values;
}

export type Delivered = { name: string; values: Record<string, string> };

const landed = (events: SecretEvent[], event: SecretEvent) => events.findIndex((logged) => logged.type === event.type && "id" in logged && "id" in event && logged.id === event.id);

function offBefore(store: Store, read: SecretEvent): OffEvent | undefined {
  const events = readEvents(store.home);
  const at = landed(events, read);
  if (at < 0) return { type: "off", id: `torn-${(read as { id: string }).id}`, reason: "this read's own event did not land whole in the event log", at: store.now.toISOString(), machine: "unknown" };
  return fold(events.slice(0, at + 1)).off;
}

const wentOff = "the store went off before this read";

export function deliver(store: Store, input: { names: string[]; thread?: string; machine: string }): Delivered[] {
  const { puts, off } = switchState(store);
  const names = [...new Set(input.names)];
  const delivered: Delivered[] = [];
  const reasons = new Map<string, string>();
  const variables = new Map<string, string>();
  for (const name of names) {
    const row = rowFor(store, name, puts.get(name));
    let reason: string | undefined;
    if (off) reason = "the store is off";
    else if (!row) reason = "unknown";
    else {
      const values = currentValues(store, row, puts.get(name));
      if (typeof values === "string") reason = values;
      else delivered.push({ name, values });
    }
    for (const key of row?.env ?? []) {
      const other = variables.get(key);
      if (other) reason ??= `sets ${key}, as ${other} does`;
      variables.set(key, name);
    }
    if (reason) reasons.set(name, reason);
  }
  const at = store.now.toISOString();
  const read = (name: string, refused = reasons.get(name)): SecretEvent => ({ type: "read", id: newId("r"), name, at, ...input.thread ? { thread: input.thread } : {}, machine: input.machine, ...refused ? { refused } : {} });
  const reads = names.map((name) => read(name));
  appendEvents(store, ...reads);
  if (off) throw new SecretRefusal(offRefusal(off));
  if (reasons.size) throw new SecretRefusal([...reasons].map(([name, reason]) => `${name}: ${reason}`).join("; "));
  const before = offBefore(store, reads.at(-1)!);
  if (before) {
    appendEvents(store, ...names.map((name) => read(name, wentOff)));
    throw new SecretRefusal(offRefusal(before));
  }
  return delivered;
}

const offRefusal = (off: OffEvent) => `The store is off since ${off.at.slice(0, 16)}Z (${off.reason}). Only the user's words turn it on: fleet secret on`;

export function turnOff(store: Store, input: { reason: string; thread?: string; machine: string }) {
  appendEvents(store, { type: "off", id: newId("o"), reason: input.reason, at: store.now.toISOString(), ...input.thread ? { thread: input.thread } : {}, machine: input.machine });
}

export function currentOff(store: Store) {
  const { off } = switchState(store);
  if (!off) throw new SecretRefusal("The store is on, so there is nothing to turn on");
  return off;
}

export const enableQuestion = "Turn the secret store back on?";
export type Heard = { words: string; thread: string; message: string; at: string; question: string; answer: string };
const plainWords = (text: string) => text.toLowerCase().replace(/[`*_"“”‘’'?.!,]/g, " ").replace(/\s+/g, " ").trim();
export const enableOptions = ["Yes, turn it on", "No, keep it off"];
const yeses = ["yes", enableOptions[0]!].map(plainWords);

export function turnOn(store: Store, off: OffEvent, heard: Heard) {
  if (plainWords(heard.question) !== plainWords(enableQuestion)) throw new SecretRefusal(`The user answered "${heard.question}", not "${enableQuestion}". Ask them that question with the question tool, with the options "${enableOptions.join('" and "')}"`);
  if (!yeses.includes(plainWords(heard.answer))) throw new SecretRefusal(`The user answered "${heard.answer}", not "${enableOptions[0]}", so the store stays off`);
  if (fold(readEvents(store.home)).heard.has(heardKey(heard))) throw new SecretRefusal("That message of the user's already turned the store on once. Ask them again");
  if (Date.parse(heard.at) <= Date.parse(off.at)) throw new SecretRefusal(`The user wrote that before the store went off on ${off.at.slice(0, 16)}Z. Only an answer after it turns the store on; ask them`);
  appendEvents(store, { type: "on", off: off.id, words: heard.words, thread: heard.thread, message: heard.message, at: store.now.toISOString() });
  const after = fold(readEvents(store.home)).off;
  if (after) throw new SecretRefusal(`The store went off again on ${after.at.slice(0, 16)}Z (${after.reason}) while the user's words were read, so it stays off. Ask them again`);
}

export function listLines(store: Store): string[] {
  const { puts, off } = fold(readEvents(store.home));
  return [
    off ? `Store: off since ${off.at.slice(0, 16)}Z (${off.reason})` : "Store: on",
    ...store.rows.map((row) => rowLine(store, row, puts.get(row.name))),
    ...[...puts.values()].filter(isLane).map((put) => rowLine(store, laneRow(put), put)),
  ];
}

function printedLines(store: Store, row: SecretRow, put: PutEvent) {
  const laneLines = isLane(put) ? [droppedLine([put.name], put.lane), revokeLine(put), latePutLine(put), JSON.stringify(dropOf(put, put.at)), ...reportHeadings] : [];
  const day = (at: string | undefined) => at?.slice(0, 10) ?? "";
  const ends = [put.storeExpiresAt, put.expiresAt].filter((at): at is string => !!at).sort();
  const states = [...ends.flatMap((at) => [`expires ${day(at)}`, `expired ${day(at)}`]), `past its store expiry ${day(put.storeExpiresAt)}`, "missing its value file", "dropped by its lane", "missing"];
  const stateLines = states.map((state) => `${row.name}: ${state}. ${cardText(row, put)}`);
  return [rowLine(store, row, put), cardText(row, put), storedLine(put), ...laneLines, ...stateLines];
}

const stringsOf = (event: object) => Object.values(event).filter((value): value is string => typeof value === "string");
export const reportHeadings = ["### Still yours", "### Late secret puts"];
const dropOf = (put: PutEvent, at: string): SecretEvent => ({ type: "drop", id: newId("d"), name: put.name, lane: put.lane!, put: put.id, at });

export const withheldLine = "A line was withheld, as it would show a stored value.";
export const safeLines = (lines: string[], values: string[]) => lines.map((line) => unshown([line, withheldLine, "Withheld"], values));

export function storedValues(home: string): string[] {
  let puts: PutEvent[];
  try { puts = [...fold(readEvents(home)).puts.values()]; } catch { return []; }
  return puts.flatMap((put) => { try { return Object.values(parseValues(readFileSync(valuePath(home, put), "utf8"))).filter(Boolean); } catch { return []; } });
}

export const storedLine = (put: PutEvent) => `Stored ${put.name} (${put.id})${put.lane ? ` for lane ${put.lane}` : ""}; store expiry ${put.storeExpiresAt?.slice(0, 10)}.`;
export const droppedLine = (names: string[], lane: string) => names.length ? `Dropped ${names.join(", ")} of lane ${lane}; their values are deleted.` : `Lane ${lane} holds no secret; nothing to drop.`;
export const revokeLine = (put: LanePut) => `- Revoke ${put.name} (lane ${put.lane}): ${put.revoke ?? "no revoke link; it expires on its own"}`;
export const latePutLine = (put: PutEvent) => `- ${put.why === "missed" ? "**Miss:** " : ""}${put.name} put ${put.at.slice(0, 16).replace("T", " ")} UTC, why ${put.why}.`;

const whereOf = (row: SecretRow) => [row.project && `project ${row.project}`, row.region?.toUpperCase()].filter(Boolean).join(", ");

function rowLine(store: Store, row: SecretRow, put: PutEvent | undefined) {
  const where = whereOf(row);
  const expired = put?.storeExpiresAt && Date.parse(put.storeExpiresAt) <= store.now.getTime();
  const problem = isFileRow(row) && fileState(store.home, row);
  const state = isFileRow(row) ? `own file ~/${row.file.path}${problem ? `, ${problem}` : ""}` : !put ? "missing" : expired ? `expired ${put.storeExpiresAt!.slice(0, 10)}` : `stored ${put.at.slice(0, 10)}, store expiry ${put.storeExpiresAt?.slice(0, 10)}`;
  const unchecked = put?.unchecked ? ` (unchecked: ${put.unchecked})` : "";
  return `${row.name}: ${row.file ? "existing" : isLane(put) ? "lane" : "standing"}, ${row.provider.name}${where ? `, ${where}` : ""}, scope ${row.scope}${unchecked}, ${state}; env ${row.env.join(" ")}`;
}

export function cardText(row: SecretRow, put?: PutEvent) {
  if (isLane(put)) {
    const revoke = put.revoke ? ` Revoke the old one at ${put.revoke}.` : "";
    return `Ask the user with one request_secret card (delivery "file") for ${row.name}: lane ${put.lane}'s secret for ${put.env}, which lives at most ${laneDays} days.${revoke} The card asks for the value alone, on one line. Then: fleet secret put ${row.name} --file <the saved file> --lane ${put.lane} --env ${put.env} --why <why> (--expires <a date within ${laneDays} days> | --revoke <link>)`;
  }
  const where = whereOf(row);
  const kind = row.file ? "an existing secret with its own lifecycle" : `a standing secret: set its expiry within ${standingDays} days, or none`;
  const paste = row.env.length === 1 ? "the value alone, on one line" : `one line per variable: ${row.env.map((key) => `${key}=…`).join(", ")}`;
  const store = row.file ? `Then store it with: ${row.file.renew}` : `Then: fleet secret put ${row.name} --file <the saved file>`;
  return `Ask the user with one request_secret card (delivery "file") for ${row.name}: ${row.provider.name}${where ? ` for ${where}` : ""}, scope ${row.scope}, ${kind}. Create or revoke it at ${row.settings}. The card asks for ${paste}. ${store}`;
}

export async function needLines(store: Store, input: { names: string[]; thread?: string; machine: string }): Promise<string[]> {
  const names = [...new Set(input.names)];
  const held = fold(readEvents(store.home)).puts;
  const unknown = names.filter((name) => !rowFor(store, name, held.get(name)));
  if (unknown.length) throw new SecretRefusal(`No declared secret ${unknown.join(", ")}. fleet secret list shows the names`);
  const read = (name: string, refused?: string): SecretEvent => ({ type: "read", id: newId("r"), name, at: store.now.toISOString(), ...input.thread ? { thread: input.thread } : {}, machine: input.machine, check: true, ...refused ? { refused } : {} });
  const lines: string[] = [];
  for (const [index, name] of names.entries()) {
    const now = switchState(store);
    if (now.off) {
      appendEvents(store, ...names.slice(index).map((rest) => read(rest, "the store is off")));
      throw new SecretRefusal(`The store is off since ${now.off.at.slice(0, 16)}Z (${now.off.reason}), so no check runs. Only the user's words turn it on: fleet secret on`);
    }
    const put = now.puts.get(name);
    const row = rowFor(store, name, put);
    if (!row) { appendEvents(store, read(name, "dropped")); lines.push(`${name}: dropped by its lane.`); continue; }
    const values = currentValues(store, row, put);
    const logged = read(name, typeof values === "string" ? values : undefined);
    appendEvents(store, logged);
    const before = typeof values === "string" ? undefined : offBefore(store, logged);
    if (before) {
      appendEvents(store, ...names.slice(index).map((rest) => read(rest, wentOff)));
      throw new SecretRefusal(`${offRefusal(before)}. No check ran with ${name}'s value`);
    }
    const checked = typeof values === "string" ? undefined : await checkOf(row.provider, values);
    if (typeof values === "string") lines.push(`${name}: ${values}. ${cardText(row, put)}`);
    else if (checked && !checked.ok) lines.push(`${name}: failing its check (${unshown([checked.reason, "its reason would show part of the value"], Object.values(values))}). ${cardText(row, put)}`);
  }
  const end = fold(readEvents(store.home)).off;
  if (end) throw new SecretRefusal(`The store went off on ${end.at.slice(0, 16)}Z (${end.reason}) during the checks, so their answers are withheld. Only the user's words turn it on: fleet secret on`);
  const one = names.length === 1;
  return lines.length ? lines : [`Nothing to ask: ${names.join(", ")} ${one ? "is" : "are"} held and ${one ? "passes its check" : "pass their checks"}.`];
}

export function dueLines(store: Store): string[] {
  const { puts } = fold(readEvents(store.home));
  const lines: string[] = [];
  const lanes = [...puts.values()].filter(isLane).map((put) => ({ row: laneRow(put), put }));
  for (const { row, put } of [...store.rows.map((row) => ({ row, put: puts.get(row.name) })), ...lanes]) {
    const ends = [put?.storeExpiresAt, put?.expiresAt].filter((at): at is string => !!at).map(Date.parse);
    const end = ends.length ? Math.min(...ends) : undefined;
    const day = end === undefined ? "" : new Date(end).toISOString().slice(0, 10);
    let state: string | undefined;
    if (isFileRow(row)) state = fileState(store.home, row) === "missing" ? "missing" : undefined;
    else if (!put) state = "missing";
    else if (end !== undefined && end <= store.now.getTime()) state = `expired ${day}`;
    else if (end !== undefined && end - store.now.getTime() <= (isLane(put) ? laneDueDays : dueDays) * dayMs) state = `expires ${day}`;
    if (state) lines.push(`${row.name}: ${state}. ${cardText(row, put)}`);
  }
  return lines.length ? lines : [`Nothing due: no standing secret expires within ${dueDays} days, and no lane secret within ${laneDueDays} day.`];
}

const removeValue = (home: string, put: PutEvent) => rmSync(valuePath(home, put), { force: true });

function droppedWhole(store: Store, puts: PutEvent[]) {
  if (!puts.length) return [];
  const drops = puts.map((put) => dropOf(put, store.now.toISOString()));
  appendEvents(store, ...drops);
  const events = readEvents(store.home);
  return puts.filter((_, index) => landed(events, drops[index]!) >= 0);
}

const tornDrop = (puts: PutEvent[]) => new SecretRefusal(`The drop of ${puts.map((put) => put.name).join(", ")} did not land whole in the event log, so ${puts.length === 1 ? "its value stays" : "their values stay"}, and the torn line keeps the store off. Only the user's words turn it on: fleet secret on`);

export function dropLane(store: Store, lane: string): string[] {
  const events = readEvents(store.home);
  const held = [...fold(events).puts.values()].filter((put) => put.lane === lane);
  const ended = droppedWhole(store, held);
  const kept = new Set(held.filter((put) => !ended.includes(put)).map((put) => put.id));
  for (const event of events) if (event.type === "put" && event.lane === lane && !kept.has(event.id)) removeValue(store.home, event);
  if (kept.size) throw tornDrop(held.filter((put) => kept.has(put.id)));
  return ended.map((put) => put.name);
}

const orphanGraceMs = 60 * 60 * 1000;
const valueFilePattern = /^[a-z0-9][a-z0-9-]*\.p-[0-9a-f]{12}$/;

export function sweep(store: Store) {
  const diskNow = Date.now();
  const events = readEvents(store.home);
  const due = [...fold(events).puts.values()].filter((put) => put.lane && put.storeExpiresAt && Date.parse(put.storeExpiresAt) <= store.now.getTime());
  const expired = droppedWhole(store, due);
  for (const put of expired) removeValue(store.home, put);
  if (expired.length < due.length) throw tornDrop(due.filter((put) => !expired.includes(put)));
  const current = new Set([...fold(readEvents(store.home)).puts.values()].map((put) => `${put.name}.${put.id}`));
  const named = new Set(events.flatMap((event) => event.type === "put" ? [`${event.name}.${event.id}`] : []));
  const logKept = existsSync(eventLogPath(store.home));
  let files: string[] = [];
  try { files = readdirSync(valuesDir(store.home)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let old = 0;
  for (const file of files) {
    if (!valueFilePattern.test(file) || current.has(file)) continue;
    const path = join(valuesDir(store.home), file);
    let info;
    try { info = lstatSync(path); } catch { continue; }
    if (!info.isFile()) continue;
    if (named.has(file) || (logKept && diskNow - info.mtimeMs > orphanGraceMs)) { rmSync(path, { force: true }); old++; }
  }
  return { expired: expired.length, old };
}

export const lanePuts = (home: string, lane: string) => readEvents(home).filter((event): event is PutEvent => event.type === "put" && event.lane === lane);

export type LaneReport = { revokes: string[]; late: string[] };

export function laneReport(home: string, lane: string): LaneReport {
  const puts = lanePuts(home, lane);
  const latest = [...new Map(puts.map((put) => [put.name, put])).values()].filter(isLane).filter((put) => put.revoke);
  const values = storedValues(home);
  return { revokes: safeLines(latest.map(revokeLine), values), late: safeLines(puts.filter((put) => put.why !== "intake").map(latePutLine), values) };
}
