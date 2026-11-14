import { type Hook, printing, runHook } from "../lib/hook.ts";

export type Provider = "claude" | "codex";
export type HookEvent =
  | { hook_event_name: "UserPromptSubmit"; prompt: string }
  | { hook_event_name: "PostToolUse"; tool_response: unknown };
export type HookDecision = {
  decision?: "block";
  reason?: string;
  hookSpecificOutput?:
    | { hookEventName: "UserPromptSubmit"; suppressOriginalPrompt: true }
    | { hookEventName: "PostToolUse"; updatedToolOutput: unknown; additionalContext: string };
};

const start = String.raw`(?:(?<![A-Za-z0-9])|(?<=\x1b\[[0-9;]*m))`;
const lineBreak = String.raw`(?:\s|\\[rn])`;
const lineEnd = String.raw`(?:\r?\n|(?:\\r)?\\n)`;
const coderToken = "[A-Za-z0-9]{10}-[A-Za-z0-9]{22}";
const colour = String.raw`(?:(?:\x1b|\\u001[bB])\[[0-9;]*m)*`;
const quote = String.raw`(?:\\?["'])?`;
const metabaseCookie = String.raw`metabase\.(?:SESSION|DEVICE)`;
const metabaseValue = "(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{20,}";
const gap = String.raw`(?:\s|\\[rnt]){0,16}`;
const cookieName = new RegExp(`^${metabaseCookie}$`);
const key = (name: string) => String.raw`(?<![\w$-])${quote}${name}${quote}${gap}:${gap}${quote}`;
const nameKey = new RegExp(key("name"), "g");
const cookieNameKey = new RegExp(String.raw`${key("name")}${metabaseCookie}(?![\w.-])`, "g");
const valueKey = new RegExp(`${key("value")}(${metabaseValue})`, "g");

function cookieRecordValues(text: string) {
  const cookies = [...text.matchAll(cookieNameKey)].map((match) => match.index);
  if (!cookies.length) return [];
  const values = [...text.matchAll(valueKey)].map((match) => ({ at: match.index, value: match[1]! }));
  const records = recordsAt(text, [...cookies, ...values.map((value) => value.at)]);
  const cookieRecords = new Set(cookies.map((at) => records.get(at)));
  return values.filter((value) => cookieRecords.has(records.get(value.at))).map((value) => value.value);
}

function recordsAt(text: string, positions: number[]) {
  const wanted = [...new Set(positions)].sort((left, right) => left - right);
  const records = new Map<number, string>();
  const open: number[] = [];
  let item = 0;
  let quoted = false;
  let lineStart = true;
  let next = 0;
  for (let at = 0; next < wanted.length; at++) {
    while (wanted[next] === at) records.set(wanted[next++]!, `${open.at(-1) ?? -1}:${item}`);
    const char = text[at];
    if (char === '"' && text[at - 1] !== "\\") quoted = !quoted;
    else if (!quoted && char === "{") open.push(at);
    else if (!quoted && char === "}") open.pop();
    else if (!quoted && lineStart && char === "-" && text[at + 1] === " ") item++;
    lineStart = char === "\n" || (lineStart && (char === " " || char === "\t"));
  }
  return records;
}

type Shape = { kind: string; pattern: RegExp } | { kind: string; values: (text: string) => string[] };
const shapes: Shape[] = [
  { kind: "PostHog personal API key", pattern: new RegExp(`${start}phx_[A-Za-z0-9]{30,}`, "g") },
  { kind: "PostHog secret API key", pattern: new RegExp(`${start}phs_[A-Za-z0-9]{30,}`, "g") },
  { kind: "PostHog OAuth token", pattern: new RegExp(`${start}ph[ar]_[A-Za-z0-9]{30,}`, "g") },
  { kind: "GitHub token", pattern: new RegExp(`${start}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})`, "g") },
  { kind: "OpenAI or Anthropic API key", pattern: new RegExp(`${start}sk-(?:(?:proj|svcacct|admin|ant|or)-(?=[A-Za-z0-9_-]{0,200}[0-9])[A-Za-z0-9_-]{32,}|(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{32,})`, "g") },
  { kind: "Slack token", pattern: new RegExp(`${start}x(?:ox[abposre]|app)-[0-9]+-[A-Za-z0-9-]{10,}`, "g") },
  { kind: "Slack webhook URL", pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g },
  { kind: "Convex deploy key", pattern: new RegExp(`(?<![A-Za-z0-9_-])(?:prod|dev|preview|project):[A-Za-z0-9:_-]{1,120}\\|[A-Za-z0-9+/=_-]{30,}`, "g") },
  { kind: "Coder session token", pattern: new RegExp(String.raw`(?:(?<=^${colour}[+-]?)|(?<=\\[rn]${colour}[+-]?|["']))[ \t]*${colour}${coderToken}${colour}[ \t]*(?=$|\\[rn]|\\?["'])`, "gm") },
  { kind: "Coder session token", pattern: new RegExp(String.raw`(?=${coderToken}(?![A-Za-z0-9]))(?<=(?:coder[_-]?session[_-]?token(?:\\?["'])?[ \t]*[:=]|--token[ \t=])[ \t]*(?:\\?["'])?)${coderToken}`, "gi") },
  { kind: "Metabase session cookie", pattern: new RegExp(String.raw`(?<=(?<![\w.-])${metabaseCookie}${quote}(?:${gap}[=:]${gap}|\t+)${quote})${metabaseValue}`, "g") },
  { kind: "Metabase session cookie", values: cookieRecordValues },
  { kind: "private key", pattern: new RegExp(`-----BEGIN [A-Z ]*PRIVATE KEY-----(?:${lineBreak}*[A-Za-z-]+:[^\\r\\n\\\\]*${lineEnd})*${lineBreak}*[A-Za-z0-9+/=]{20,}(?:[A-Za-z0-9+/=\\s]|\\\\[rn])*(?:-----END [A-Z ]*PRIVATE KEY-----)?`, "g") },
];

function mapStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === "string") return change(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, change));
  if (value && typeof value === "object") return mapProperties(value, change);
  return value;
}

function mapProperties(value: object, change: (text: string) => string) {
  const unusedName = uniqueNames();
  const name = (value as { name?: unknown }).name;
  const cookieOf = (key: string) => cookieName.test(key) ? key : key === "value" && typeof name === "string" && cookieName.test(name) ? name : undefined;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const cookie = cookieOf(key);
    return [unusedName(change(key)), cookie && typeof entry === "string" ? cookieValue(cookie, entry, change) : mapStrings(entry, change)];
  }));
}

function cookieValue(cookie: string, entry: string, change: (text: string) => string) {
  const named = `${cookie}=`;
  const changed = change(`${named}${entry}`);
  return changed.startsWith(named) ? changed.slice(named.length) : change(entry);
}

function uniqueNames() {
  const taken = new Set<string>();
  const lastCopy = new Map<string, number>();
  return (name: string) => {
    let copy = lastCopy.get(name) ?? 1;
    let candidate = name;
    while (taken.has(candidate)) candidate = `${name} ${++copy}`;
    lastCopy.set(name, copy);
    taken.add(candidate);
    return candidate;
  };
}

export function secretKinds(value: unknown): string[] {
  const kinds = new Set<string>();
  mapStrings(value, (text) => {
    for (const shape of shapes) if ("pattern" in shape ? text.match(shape.pattern) : shape.values(text).length) kinds.add(shape.kind);
    return text;
  });
  return [...kinds];
}

export const replaceSecrets = (text: string, replace: (kind: string, value: string) => string) =>
  shapes.reduce((result, shape) => "pattern" in shape
    ? result.replace(shape.pattern, (value) => replace(shape.kind, value))
    : shape.values(result).reduce((changed, value) => changed.split(value).join(replace(shape.kind, value)), result), text);

/** Replaces every secret-shaped value in a text with its kind. */
export const redactSecrets = (text: string) => replaceSecrets(text, (kind) => `[redacted ${kind}]`);

const redact = (value: unknown) => mapStrings(value, redactSecrets);

const storeHint = 'T3\'s `request_secret` tool and file delivery (`delivery: "file"`), then hand that file to `fleet secret put --file <path>` where this Fleet has `fleet secret`';

function promptReason(kinds: string[]) {
  return `Fleet held this message back: it looks like it carries a ${kinds.join(", ")}. Send it again without the value. `
    + `To give the agent a secret, let it ask with ${storeHint}, or save it in a file or an environment variable yourself and tell the agent its name. `
    + "If the value is real, rotate it: the app may have saved the message.";
}

function toolOutputReason(kinds: string[], action: string) {
  return `Fleet ${action} this tool output: it carries a ${kinds.join(", ")}. Never print a secret or repeat it in chat, commands, or files. `
    + "Rerun the command so its output leaves the value out, for example by reading it into an environment variable. "
    + `When you need a secret from the user, ask with ${storeHint}, or pass a \`request_secret\` secretRef to a T3 tool; never save the value by hand. `
    + "Without T3, ask the user to save it in a file or an environment variable and give you its name.";
}

function promptDecision(provider: Provider, kinds: string[]): HookDecision {
  const decision: HookDecision = { decision: "block", reason: promptReason(kinds) };
  if (provider === "claude") decision.hookSpecificOutput = { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true };
  return decision;
}

function toolOutputDecision(provider: Provider, kinds: string[], output: unknown): HookDecision {
  if (provider === "codex") return { decision: "block", reason: toolOutputReason(kinds, "withheld") };
  return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: redact(output), additionalContext: toolOutputReason(kinds, "redacted") } };
}

export function guard(provider: Provider, event: HookEvent): HookDecision | undefined {
  if (event.hook_event_name === "UserPromptSubmit") {
    const kinds = secretKinds(event.prompt);
    return kinds.length ? promptDecision(provider, kinds) : undefined;
  }
  const kinds = secretKinds(event.tool_response);
  return kinds.length ? toolOutputDecision(provider, kinds, event.tool_response) : undefined;
}

export const hook: Hook = async (provider, readInput) =>
  provider === "claude" || provider === "codex" ? printing(guard(provider, JSON.parse(await readInput()) as HookEvent)) : { code: 1, stdout: "", stderr: "Usage: secret-guard.ts claude|codex\n" };

if (import.meta.main) await runHook(hook);
