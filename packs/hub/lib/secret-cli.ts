import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { sep } from "node:path";
import { answeredAt, heardInThread } from "../../pull-requests/lib/decision-cli.ts";
import { thisMachine } from "../../pull-requests/lib/decision-ledger.ts";
import type { ThreadWords } from "../../pull-requests/lib/proof-answers.ts";
import { fleetOnHub, HubUnreachable, lastLine, remoteHub, runSsh, type Env, type Ssh } from "./hub-transport.ts";
import { checkedRows, injectedRows } from "./secret-rows.ts";
import {
  currentOff, deliver, dueLines, enableQuestion, failureOf, listLines, needLines, putValue, secretFilesDir, standingDays, storedLine, turnOff, turnOn, whys,
  type Delivered, type Heard, type PutInput, type SecretRow, type Store, type Why,
} from "./secret-store.ts";

export const usage = `Usage:
  fleet secret put <name> --file <request_secret file> [--expires <date>] [--why <why>]
  fleet secret run <name>... -- <command> [args...]
  fleet secret list [--due | --need <name>...]
  fleet secret off <reason>
  fleet secret on --words '<date> "<the user's words>"' --thread <id> [--message <id>]

The secret store keeps each credential once, on the Fleet hub that the setting hub.alias names; other machines
reach it over SSH. Without a hub, it lives on this machine. Packs and the profile declare its secrets.
put stores a value from a request_secret file (delivery "file"), only from T3's secret-file directory, and deletes
the file whatever happens. The file holds the value on one line, or one VAR=value line per variable of the secret.
A new value replaces the stored one only after its check passes. --expires is the provider's expiry; the store
expiry is the earlier of it and ${standingDays} days. --why: ${whys.join(", ")} (default intake).
run sets each secret's variables in the command's environment only, and replaces each value in its output with
[redacted <name>]. It exits with the command's code. A value the command transforms or writes to a file is not redacted.
list shows each secret's kind, project, region, scope and state, never a value. --need prints the request_secret
card text of each named secret that is missing or fails its check. --due lists each secret within 7 days of its
expiry, past it, or missing, with its card text.
off stops every store read at once; any agent may run it. on needs the user's dated, quoted "Yes" to the question
"${enableQuestion}", asked with your question tool in the T3 thread after the store went off.`;

export type SecretContext = {
  home: string; env: Env;
  out: (text: string) => void; err: (text: string) => void;
  stdin?: () => Promise<string>;
  ssh?: Ssh; now?: () => Date; threadWords?: ThreadWords; rows?: SecretRow[];
  beforeAppend?: () => Promise<void>;
};

class UsageError extends Error {}

type Request =
  | ({ op: "put" } & PutInput)
  | { op: "deliver"; names: string[]; thread?: string; machine: string }
  | { op: "off"; reason: string; thread?: string; machine: string }
  | ({ op: "on" } & Heard)
  | { op: "list"; need?: string[]; due?: boolean; thread?: string; machine?: string };
type Answer = { ok: true; lines?: string[]; delivered?: Delivered[] } | { ok: false; error: string };

const machineOf = (context: SecretContext) => thisMachine(context.env);
const threadOf = (context: SecretContext) => context.env.T3CODE_THREAD_ID ? { thread: context.env.T3CODE_THREAD_ID } : {};
const slowCallMs = 180_000;
const sshFailed = 255;

async function answer(context: SecretContext, request: Request): Promise<Answer> {
  try {
    const rows = context.rows ? checkedRows(context.rows) : await injectedRows(context.env);
    const store: Store = { home: context.home, rows, now: context.now?.() ?? new Date(), ...context.beforeAppend ? { beforeAppend: context.beforeAppend } : {} };
    if (request.op === "put") return { ok: true, lines: [storedLine(await putValue(store, request))] };
    if (request.op === "deliver") return { ok: true, delivered: deliver(store, request) };
    if (request.op === "off") { turnOff(store, request); return { ok: true, lines: ["The store is off: every read is refused until the user's words turn it on (fleet secret on)."] }; }
    if (request.op === "on") {
      await turnOn(store, currentOff(store), request);
      return { ok: true, lines: [`The store is on again, by the user's words ${request.words} (thread ${request.thread}).`] };
    }
    if (request.need) return { ok: true, lines: await needLines(store, { names: request.need, ...request.thread ? { thread: request.thread } : {}, machine: request.machine ?? "unknown" }) };
    if (request.due) return { ok: true, lines: dueLines(store) };
    return { ok: true, lines: listLines(store) };
  } catch (error) {
    return { ok: false, error: failureOf(error) };
  }
}

async function ask(context: SecretContext, request: Request): Promise<Answer> {
  const hub = remoteHub(context.home, context.env);
  if (!hub) return answer(context, request);
  const slow = request.op === "put" || (request.op === "list" && request.need !== undefined);
  const result = await (context.ssh ?? runSsh)(hub, fleetOnHub(hub, ["secret", "hub"]), JSON.stringify(request), slow ? slowCallMs : undefined);
  if (result.code === sshFailed) throw new HubUnreachable(`the hub ${hub} did not answer over SSH (exit ${result.code}${lastLine(result.stderr) ? `: ${lastLine(result.stderr)}` : ""})`);
  if (result.code !== 0) throw new HubUnreachable(`fleet secret hub failed on the hub ${hub} (exit ${result.code}). Its output is not shown, as it could hold a value; run fleet update there, then look at it on the hub`);
  try { return JSON.parse(result.stdout) as Answer; }
  catch { throw new HubUnreachable(`the hub ${hub} sent no answer the store understands; run fleet update there`); }
}

async function serve(context: SecretContext) {
  if (remoteHub(context.home, context.env)) throw new UsageError("fleet secret hub runs only on the hub; other commands reach it themselves");
  let request: Request;
  try { request = JSON.parse(await (context.stdin?.() ?? Bun.stdin.text())) as Request; }
  catch { context.out(JSON.stringify({ ok: false, error: "the request was not JSON" })); return 0; }
  context.out(JSON.stringify(await answer(context, request)));
  return 0;
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value.\n${usage}`);
  args.splice(index, 2);
  return value;
}

function noMore(args: string[]) {
  if (args.length) throw new UsageError(`Unexpected ${args.join(" ")}.\n${usage}`);
}

const done = (context: SecretContext, reply: Answer) => {
  if (!reply.ok) { context.err(`Fleet secret: ${reply.error}\n`); return 1; }
  for (const line of reply.lines ?? []) context.out(`${line}\n`);
  return 0;
};

function secretFile(path: string | undefined, home: string) {
  if (path === undefined || path.startsWith("--")) throw new UsageError(`put needs --file with a request_secret file.\n${usage}`);
  let real: string;
  try { real = realpathSync(path); } catch { throw new UsageError(`${path} does not exist. Ask the user again with a request_secret card, delivery "file"`); }
  let directory: string;
  try { directory = realpathSync(secretFilesDir(home)); } catch { directory = secretFilesDir(home); }
  if (!real.startsWith(directory + sep) || !lstatSync(real).isFile()) throw new UsageError(`put takes only a request_secret file in ~/.t3/userdata/secrets/files, not ${path}. That file was left alone`);
  return real;
}

function fileOptions(args: string[]) {
  const paths: (string | undefined)[] = [];
  for (let at = args.indexOf("--file"); at >= 0; at = args.indexOf("--file")) {
    const value = args[at + 1];
    const named = value !== undefined && !value.startsWith("--");
    paths.push(named ? value : undefined);
    args.splice(at, named ? 2 : 1);
  }
  return paths;
}

async function put(args: string[], context: SecretContext) {
  const paths = fileOptions(args);
  const cards = paths.flatMap((path) => { try { return [secretFile(path, context.home)]; } catch { return []; } });
  const remove = () => cards.forEach((card) => rmSync(card, { force: true }));
  const interrupted = () => { remove(); process.exit(130); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    if (paths.length > 1) throw new UsageError(`put takes one --file; each request_secret file it named in the secret-file directory was deleted.\n${usage}`);
    const real = secretFile(paths[0], context.home);
    const expires = option(args, "--expires");
    const why = option(args, "--why") ?? "intake";
    const [name, ...rest] = args;
    noMore(rest);
    if (!name || name.startsWith("-")) throw new UsageError(`put needs the secret's name.\n${usage}`);
    if (!(whys as readonly string[]).includes(why)) throw new UsageError(`--why takes one of ${whys.join(", ")}`);
    const text = readFileSync(real, "utf8");
    return done(context, await ask(context, { op: "put", name, text, ...expires ? { expires } : {}, why: why as Why, ...threadOf(context), machine: machineOf(context) }));
  } finally {
    remove();
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }
}

export function redactExact(text: string, secrets: { value: string; label: string }[]) {
  const spans: { start: number; end: number; label: string }[] = [];
  for (const { value, label } of secrets) {
    if (!value) continue;
    for (let start = text.indexOf(value); start >= 0; start = text.indexOf(value, start + 1)) spans.push({ start, end: start + value.length, label });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let result = "";
  let at = 0;
  for (let index = 0; index < spans.length;) {
    const { start, label } = spans[index]!;
    let end = spans[index]!.end;
    while (++index < spans.length && spans[index]!.start < end) end = Math.max(end, spans[index]!.end);
    result += text.slice(at, start) + label;
    at = end;
  }
  return result + text.slice(at);
}

const plainLabel = "[redacted]";
const withheld = "[fleet secret: a line of output was withheld, because its redaction would still show a stored value]\n";

export function lineRedactor(secrets: { value: string; label: string }[], write: (text: string) => void) {
  const safe = (text: string) => secrets.some(({ value }) => text.includes(value)) ? undefined : text;
  const show = (text: string) => write(safe(redactExact(text, secrets)) ?? safe(withheld) ?? "");
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let held = "";
  return {
    push(chunk: Uint8Array) {
      held += decoder.decode(chunk, { stream: true });
      const cut = held.lastIndexOf("\n");
      if (cut < 0) return;
      for (const line of held.slice(0, cut + 1).split(/(?<=\n)/)) show(line);
      held = held.slice(cut + 1);
    },
    end() {
      held += decoder.decode();
      if (held) show(held);
      held = "";
    },
  };
}

async function pump(stream: ReadableStream<Uint8Array>, redactor: ReturnType<typeof lineRedactor>) {
  for await (const chunk of stream) redactor.push(chunk);
  redactor.end();
}

async function run(args: string[], context: SecretContext) {
  const split = args.indexOf("--");
  const names = split < 0 ? [] : args.slice(0, split);
  const command = split < 0 ? [] : args.slice(split + 1);
  if (!names.length || !command.length || names.some((name) => name.startsWith("-"))) throw new UsageError(`run needs at least one name, then -- and the command.\n${usage}`);
  const reply = await ask(context, { op: "deliver", names, ...threadOf(context), machine: machineOf(context) });
  if (!reply.ok) return done(context, reply);
  const delivered = reply.delivered ?? [];
  const keys = delivered.flatMap(({ values }) => Object.keys(values));
  const twice = keys.find((key, index) => keys.indexOf(key) !== index);
  if (twice) return done(context, { ok: false, error: `two of ${names.join(", ")} set ${twice}, so none was used` });
  const all = delivered.flatMap(({ values }) => Object.values(values).filter(Boolean));
  const label = (name: string) => all.some((value) => `[redacted ${name}]`.includes(value)) ? plainLabel : `[redacted ${name}]`;
  const secrets = delivered.flatMap(({ name, values }) => Object.values(values).filter(Boolean).map((value) => ({ value, label: label(name) })));
  const env = { ...process.env, ...Object.assign({}, ...delivered.map(({ values }) => values)) as Record<string, string> };
  const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  await Promise.all([pump(child.stdout, lineRedactor(secrets, context.out)), pump(child.stderr, lineRedactor(secrets, context.err))]);
  return await child.exited;
}

async function hearOn(args: string[], context: SecretContext) {
  const words = option(args, "--words");
  const thread = option(args, "--thread");
  const message = option(args, "--message");
  noMore(args);
  if (!words || !thread) throw new UsageError(`on needs the user's dated, quoted words and the T3 thread they wrote them in.\n${usage}`);
  let heard: Heard;
  try {
    const word = await heardInThread(thread, words, message, { home: context.home, cwd: process.cwd(), env: context.env, print: context.out, ...context.threadWords ? { threadWords: context.threadWords } : {} });
    if (word.source !== "question") throw new Error(`"${word.text}" is a message the user typed. Only their answer to your question tool turns the store on: ask them with it`);
    heard = { words, thread: word.thread, message: word.id, at: answeredAt(word), question: word.answered, answer: word.text };
  } catch (error) {
    context.err(`Fleet secret: ${(error as Error).message}\n`);
    return 1;
  }
  return done(context, await ask(context, { op: "on", ...heard }));
}

const helpWords = ["help", "--help", "-h"];

export async function secretCommand(args: string[], context: SecretContext): Promise<number> {
  const [name, ...rest] = args;
  try {
    if (name === undefined || helpWords.includes(name)) { context.out(`${usage}\n`); return name === undefined ? 1 : 0; }
    if (name === "hub") return await serve(context);
    if (name === "put") return await put(rest, context);
    if (name === "run") return await run(rest, context);
    if (name === "list") {
      const due = rest[0] === "--due";
      const need = rest[0] === "--need" ? rest.slice(1) : undefined;
      if (need?.length === 0 || (due && rest.length > 1) || (!due && !need && rest.length)) throw new UsageError(`list takes --due, or --need with one or more names.\n${usage}`);
      return done(context, await ask(context, { op: "list", ...need ? { need, ...threadOf(context), machine: machineOf(context) } : {}, ...due ? { due } : {} }));
    }
    if (name === "off") {
      const reason = rest.join(" ").trim();
      if (helpWords.includes(reason)) { context.out(`${usage}\n`); return 0; }
      if (!reason) throw new UsageError(`off needs a reason.\n${usage}`);
      if (reason.startsWith("-")) throw new UsageError(`off takes no options; its reason cannot start with -.\n${usage}`);
      return done(context, await ask(context, { op: "off", reason, ...threadOf(context), machine: machineOf(context) }));
    }
    if (name === "on") return await hearOn(rest, context);
    throw new UsageError(`Unknown command ${name}.\n${usage}`);
  } catch (error) {
    if (!(error instanceof UsageError || error instanceof HubUnreachable)) throw error;
    context.err(`Fleet secret: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
