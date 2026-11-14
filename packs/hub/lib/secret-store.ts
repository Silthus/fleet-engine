import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
};
export type OffEvent = { type: "off"; id: string; reason: string; at: string; thread?: string; machine: string };
export type SecretEvent =
  | PutEvent
  | { type: "read"; id?: string; name: string; at: string; thread?: string; machine: string; refused?: string; check?: true }
  | OffEvent
  | { type: "on"; off: string; words: string; thread: string; message: string; at: string };

export const secretFilesDir = (home: string) => join(home, ".t3/userdata/secrets/files");
export const valuesDir = (home: string) => join(home, ".config/fleet/secrets");
export const eventLogPath = (home: string) => join(home, ".local/state/fleet/secrets.jsonl");

export class SecretRefusal extends Error {}

export const temporaryMarker = ".tmp-";

function synced(path: string, flag: string, write: (file: number) => void, mode = 0o600) {
  const file = openSync(path, flag, mode);
  try {
    write(file);
    fsyncSync(file);
  } finally { closeSync(file); }
}

export function writeFileAtomic(path: string, data: string, mode = 0o600) {
  const temporary = `${path}${temporaryMarker}${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    synced(temporary, "wx", (file) => writeSync(file, data), mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  synced(dirname(path), "r", () => undefined);
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const shapes: Record<SecretEvent["type"], (event: Record<string, unknown>) => boolean> = {
  put: (event) => isText(event.id) && isText(event.name) && isText(event.at) && (whys as readonly unknown[]).includes(event.why),
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

export function appendEvents(home: string, ...events: SecretEvent[]) {
  mkdirSync(dirname(eventLogPath(home)), { recursive: true, mode: 0o700 });
  synced(eventLogPath(home), "a", (file) => writeSync(file, `\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`));
}

export const heardKey = ({ thread, message }: { thread: string; message: string }) => `${thread}/${message}`;

export function fold(events: SecretEvent[]) {
  const puts = new Map<string, PutEvent>();
  let off: OffEvent | undefined;
  const heard = new Set<string>();
  for (const event of events) {
    if (event.type === "put") puts.set(event.name, event);
    else if (event.type === "off") off = event;
    else if (event.type === "on") { if (event.off === off?.id) off = undefined; heard.add(heardKey(event)); }
  }
  return { puts, off, heard };
}

export type Store = { home: string; rows: SecretRow[]; now: Date; beforeAppend?: () => Promise<void> };

function switchState(store: Store) {
  const state = fold(readEvents(store.home));
  if (!state.off?.id.startsWith(damagedPrefix)) return state;
  appendEvents(store.home, { type: "off", id: newId("o"), reason: `${damagedReason}, found at byte ${state.off.id.slice(damagedPrefix.length)}`, at: store.now.toISOString(), machine: "hub" });
  return fold(readEvents(store.home));
}
const dayMs = 24 * 60 * 60 * 1000;
export const standingDays = 90;
export const minimumLength = 8;
export const dueDays = 7;

const rowOf = ({ rows }: Store, name: string) => rows.find((row) => row.name === name);
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
  if (time > now.getTime() + days * dayMs) throw new SecretRefusal(`--expires ${text} is more than ${days} days out: a standing secret is rotated within ${days} days. Ask for a key that expires sooner`);
  return time;
}

export type PutInput = { name: string; text: string; expires?: string; why: Why; thread?: string; machine: string };

export const showsValue = (text: string, values: string[]) => values.some((value) => value.length >= 3 && text.includes(value));
export const unshown = (texts: string[], values: string[]) => texts.find((text) => !showsValue(text, values)) ?? "✗";
const hiddenValue = "Refused, and the reason would show part of the value. Nothing was stored";

export function failureOf(error: unknown) {
  if (error instanceof SecretRefusal) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return `The store failed${typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? ` (${code})` : ""}; its message is not shown, as it could hold a value`;
}

async function checkOf(provider: Provider, values: Record<string, string>): Promise<CheckResult> {
  try { return provider.check ? await provider.check(values) : { ok: true }; }
  catch { return { ok: false, reason: "the check failed with an error it does not show" }; }
}

export const piecesOf = (text: string) => text.split(/\r?\n/).flatMap((line) => line.includes("=") ? [line, line.slice(line.indexOf("=") + 1)] : [line]);

export async function putValue(store: Store, input: PutInput): Promise<PutEvent> {
  try {
    const row = rowOf(store, input.name);
    if (!row || row.file) throw new SecretRefusal(`No declared secret ${input.name} is kept by the store. fleet secret list shows the names`);
    return await checkAndStore(store, row, input);
  } catch (error) {
    throw new SecretRefusal(unshown([error instanceof SecretRefusal ? error.message : `${failureOf(error)}. Nothing was stored`, hiddenValue, "Refused"], piecesOf(input.text)));
  }
}

async function checkAndStore(store: Store, row: SecretRow, input: PutInput): Promise<PutEvent> {
  const fields = fieldsOf(row, input.text);
  const expires = expiryOf(input.expires, store.now, standingDays);
  const checked = await checkOf(row.provider, fields);
  if (!checked.ok) throw new SecretRefusal(`The ${row.provider.name} check refused the new ${row.name} value: ${checked.reason}. The stored value stays`);
  const storeExpires = Math.min(expires ?? Infinity, store.now.getTime() + standingDays * dayMs);
  const event: PutEvent = {
    type: "put", id: newId("p"), name: row.name, at: store.now.toISOString(), why: input.why,
    ...expires === undefined ? {} : { expiresAt: new Date(expires).toISOString() }, storeExpiresAt: new Date(storeExpires).toISOString(),
    ...input.thread ? { thread: input.thread } : {}, machine: input.machine, ...checked.unchecked ? { unchecked: checked.unchecked } : {},
  };
  const shown = [JSON.stringify(event), ...Object.values(event).filter((value): value is string => typeof value === "string"), ...printedLines(store, row, event)].join("\n");
  if (showsValue(shown, Object.values(fields))) throw new SecretRefusal(hiddenValue);
  mkdirSync(valuesDir(store.home), { recursive: true, mode: 0o700 });
  writeFileAtomic(valuePath(store.home, event), row.env.map((key) => `${key}=${fields[key]}\n`).join(""));
  await store.beforeAppend?.();
  appendEvents(store.home, event);
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
  try { return parseValues(readFileSync(valuePath(store.home, put), "utf8")); }
  catch { return "missing its value file"; }
}

export type Delivered = { name: string; values: Record<string, string> };

export async function deliver(store: Store, input: { names: string[]; thread?: string; machine: string }): Promise<Delivered[]> {
  const { puts, off } = switchState(store);
  const names = [...new Set(input.names)];
  const delivered: Delivered[] = [];
  const reasons = new Map<string, string>();
  const variables = new Map<string, string>();
  for (const name of names) {
    const row = rowOf(store, name);
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
  await store.beforeAppend?.();
  appendEvents(store.home, ...reads);
  if (off) throw new SecretRefusal(offRefusal(off));
  if (reasons.size) throw new SecretRefusal([...reasons].map(([name, reason]) => `${name}: ${reason}`).join("; "));
  const events = readEvents(store.home);
  const last = (reads.at(-1) as { id: string }).id;
  const before = fold(events.slice(0, events.findIndex((event) => event.type === "read" && event.id === last) + 1)).off;
  if (before) {
    appendEvents(store.home, ...names.map((name) => read(name, "the store went off before this read")));
    throw new SecretRefusal(offRefusal(before));
  }
  return delivered;
}

const offRefusal = (off: OffEvent) => `The store is off since ${off.at.slice(0, 16)}Z (${off.reason}). Only the user's words turn it on: fleet secret on`;

export function turnOff(store: Store, input: { reason: string; thread?: string; machine: string }) {
  appendEvents(store.home, { type: "off", id: newId("o"), reason: input.reason, at: store.now.toISOString(), ...input.thread ? { thread: input.thread } : {}, machine: input.machine });
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

export async function turnOn(store: Store, off: OffEvent, heard: Heard) {
  if (plainWords(heard.question) !== plainWords(enableQuestion)) throw new SecretRefusal(`The user answered "${heard.question}", not "${enableQuestion}". Ask them that question with the question tool, with the options "${enableOptions.join('" and "')}"`);
  if (!yeses.includes(plainWords(heard.answer))) throw new SecretRefusal(`The user answered "${heard.answer}", not "${enableOptions[0]}", so the store stays off`);
  if (fold(readEvents(store.home)).heard.has(heardKey(heard))) throw new SecretRefusal("That message of the user's already turned the store on once. Ask them again");
  if (Date.parse(heard.at) <= Date.parse(off.at)) throw new SecretRefusal(`The user wrote that before the store went off on ${off.at.slice(0, 16)}Z. Only an answer after it turns the store on; ask them`);
  await store.beforeAppend?.();
  appendEvents(store.home, { type: "on", off: off.id, words: heard.words, thread: heard.thread, message: heard.message, at: store.now.toISOString() });
  const after = fold(readEvents(store.home)).off;
  if (after) throw new SecretRefusal(`The store went off again on ${after.at.slice(0, 16)}Z (${after.reason}) while the user's words were read, so it stays off. Ask them again`);
}

export function listLines(store: Store): string[] {
  const { puts, off } = fold(readEvents(store.home));
  return [off ? `Store: off since ${off.at.slice(0, 16)}Z (${off.reason})` : "Store: on", ...store.rows.map((row) => rowLine(store, row, puts.get(row.name)))];
}

function printedLines(store: Store, row: SecretRow, put: PutEvent) {
  return [rowLine(store, row, put), cardText(row), storedLine(put)];
}

export const storedLine = (put: PutEvent) => `Stored ${put.name} (${put.id}); store expiry ${put.storeExpiresAt?.slice(0, 10)}.`;

const whereOf = (row: SecretRow) => [row.project && `project ${row.project}`, row.region?.toUpperCase()].filter(Boolean).join(", ");

function rowLine(store: Store, row: SecretRow, put: PutEvent | undefined) {
  const where = whereOf(row);
  const expired = put?.storeExpiresAt && Date.parse(put.storeExpiresAt) <= store.now.getTime();
  const problem = isFileRow(row) && fileState(store.home, row);
  const state = isFileRow(row) ? `own file ~/${row.file.path}${problem ? `, ${problem}` : ""}` : !put ? "missing" : expired ? `expired ${put.storeExpiresAt!.slice(0, 10)}` : `stored ${put.at.slice(0, 10)}, store expiry ${put.storeExpiresAt?.slice(0, 10)}`;
  const unchecked = put?.unchecked ? ` (unchecked: ${put.unchecked})` : "";
  return `${row.name}: ${row.file ? "existing" : "standing"}, ${row.provider.name}${where ? `, ${where}` : ""}, scope ${row.scope}${unchecked}, ${state}; env ${row.env.join(" ")}`;
}

export function cardText(row: SecretRow) {
  const where = whereOf(row);
  const kind = row.file ? "an existing secret with its own lifecycle" : `a standing secret: set its expiry within ${standingDays} days, or none`;
  const paste = row.env.length === 1 ? "the value alone, on one line" : `one line per variable: ${row.env.map((key) => `${key}=…`).join(", ")}`;
  const store = row.file ? `Then store it with: ${row.file.renew}` : `Then: fleet secret put ${row.name} --file <the saved file>`;
  return `Ask the user with one request_secret card (delivery "file") for ${row.name}: ${row.provider.name}${where ? ` for ${where}` : ""}, scope ${row.scope}, ${kind}. Create or revoke it at ${row.settings}. The card asks for ${paste}. ${store}`;
}

export async function needLines(store: Store, input: { names: string[]; thread?: string; machine: string }): Promise<string[]> {
  const names = [...new Set(input.names)];
  const unknown = names.filter((name) => !rowOf(store, name));
  if (unknown.length) throw new SecretRefusal(`No declared secret ${unknown.join(", ")}. fleet secret list shows the names`);
  const read = (name: string, refused?: string): SecretEvent => ({ type: "read", name, at: store.now.toISOString(), ...input.thread ? { thread: input.thread } : {}, machine: input.machine, check: true, ...refused ? { refused } : {} });
  const lines: string[] = [];
  for (const [index, name] of names.entries()) {
    const now = switchState(store);
    if (now.off) {
      appendEvents(store.home, ...names.slice(index).map((rest) => read(rest, "the store is off")));
      throw new SecretRefusal(`The store is off since ${now.off.at.slice(0, 16)}Z (${now.off.reason}), so no check runs. Only the user's words turn it on: fleet secret on`);
    }
    const row = rowOf(store, name)!;
    const values = currentValues(store, row, now.puts.get(name));
    appendEvents(store.home, read(name, typeof values === "string" ? values : undefined));
    const checked = typeof values === "string" ? undefined : await checkOf(row.provider, values);
    if (typeof values === "string") lines.push(`${name}: ${values}. ${cardText(row)}`);
    else if (checked && !checked.ok) lines.push(`${name}: failing its check (${unshown([checked.reason, "its reason would show part of the value"], Object.values(values))}). ${cardText(row)}`);
  }
  const end = fold(readEvents(store.home)).off;
  if (end) throw new SecretRefusal(`The store went off on ${end.at.slice(0, 16)}Z (${end.reason}) during the checks, so their answers are withheld. Only the user's words turn it on: fleet secret on`);
  const one = names.length === 1;
  return lines.length ? lines : [`Nothing to ask: ${names.join(", ")} ${one ? "is" : "are"} held and ${one ? "passes its check" : "pass their checks"}.`];
}

export function dueLines(store: Store): string[] {
  const { puts } = fold(readEvents(store.home));
  const lines: string[] = [];
  for (const row of store.rows) {
    const put = puts.get(row.name);
    const ends = [put?.storeExpiresAt, put?.expiresAt].filter((at): at is string => !!at).map(Date.parse);
    const end = ends.length ? Math.min(...ends) : undefined;
    const day = end === undefined ? "" : new Date(end).toISOString().slice(0, 10);
    let state: string | undefined;
    if (isFileRow(row)) state = fileState(store.home, row) === "missing" ? "missing" : undefined;
    else if (!put) state = "missing";
    else if (end !== undefined && end <= store.now.getTime()) state = `expired ${day}`;
    else if (end !== undefined && end - store.now.getTime() <= dueDays * dayMs) state = `expires ${day}`;
    if (state) lines.push(`${row.name}: ${state}. ${cardText(row)}`);
  }
  return lines.length ? lines : [`Nothing due: no secret expires within ${dueDays} days.`];
}
