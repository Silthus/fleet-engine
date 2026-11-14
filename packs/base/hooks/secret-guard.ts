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
const cookieMention = new RegExp(metabaseCookie);
const valueToken = /(?<![A-Za-z0-9._~+/-])(?=[A-Za-z0-9._~+/-]*[0-9])[A-Za-z0-9._~+/-]{20,}={0,2}(?![A-Za-z0-9._~+/=-])/g;
const wholeValue = new RegExp(`^${metabaseValue}$`);
const jsonStart = /^\s*[[{"]/;
const valueEscape = /\\u([0-9a-fA-F]{4})|\\\//g;

function cookieRecordValues(text: string): string[] {
  const json = jsonStart.test(text) ? parsedJson(text) : { parsed: false as const };
  if (json.parsed && keysIn(text) === parsedKeys(json.value)) return jsonCookieValues(json.value);
  const decoded = text.replace(valueEscape, (_, code?: string) => (code ? String.fromCharCode(parseInt(code, 16)) : "/"));
  if (!cookieMention.test(decoded)) return [];
  if (!json.parsed && decoded === text) return text.match(valueToken) ?? [];
  return decoded.search(valueToken) >= 0 ? [text] : [];
}

function parsedJson(text: string): { parsed: true; value: unknown } | { parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false };
  }
}

function keysIn(json: string) {
  let count = 0;
  let quoted = false;
  for (let at = 0; at < json.length; at++) {
    const char = json[at];
    if (quoted && char === "\\") at++;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ":") count++;
  }
  return count;
}

function parsedKeys(value: unknown) {
  let count = 0;
  for (const entry of jsonNodes(value)) if (!Array.isArray(entry) && entry && typeof entry === "object") count += Object.keys(entry).length;
  return count;
}

function jsonCookieValues(value: unknown) {
  const isCookieValue = (entry: unknown): entry is string => typeof entry === "string" && wholeValue.test(entry);
  const found: string[] = [];
  for (const entry of jsonNodes(value)) {
    if (typeof entry === "string") found.push(...cookieRecordValues(entry));
    if (Array.isArray(entry) || !entry || typeof entry !== "object") continue;
    const { name, value: cookie } = entry as { name?: unknown; value?: unknown };
    if (typeof name === "string" && cookieName.test(name) && isCookieValue(cookie)) found.push(cookie);
    for (const [key, field] of Object.entries(entry)) if (cookieName.test(key) && isCookieValue(field)) found.push(field);
  }
  return found;
}

function* jsonNodes(value: unknown) {
  const pending = [value];
  while (pending.length) {
    const entry = pending.pop();
    yield entry;
    if (entry && typeof entry === "object") for (const field of Object.values(entry)) pending.push(field);
  }
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
  return changed.startsWith(named) ? changed.slice(named.length) : changed;
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
    for (const { kind } of secretsIn(text)) kinds.add(kind);
    return text;
  });
  return [...kinds];
}

const secretsIn = (text: string) =>
  shapes.flatMap((shape) => ("pattern" in shape ? text.match(shape.pattern) ?? [] : shape.values(text)).map((value) => ({ kind: shape.kind, value })));

export function replaceSecrets(text: string, replace: (kind: string, value: string) => string) {
  const kinds = new Map<string, string>();
  for (const { kind, value } of secretsIn(text)) if (!kinds.has(value)) kinds.set(value, kind);
  const longestFirst = [...kinds].sort(([left], [right]) => right.length - left.length);
  const replaced = longestFirst.reduce((changed, [value, kind]) => changed.split(value).join(replace(kind, value)), text);
  const left = secretsIn(replaced)[0];
  return left ? replace(left.kind, text) : replaced;
}

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
  try {
    return checkedGuard(provider, event);
  } catch {
    return uncheckedGuard(provider, event);
  }
}

function uncheckedGuard(provider: Provider, event: HookEvent): HookDecision {
  const kinds = ["value Fleet's secret guard could not check"];
  if (event.hook_event_name === "UserPromptSubmit") return promptDecision(provider, kinds);
  if (provider === "codex") return toolOutputDecision(provider, kinds, undefined);
  return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "[withheld: Fleet's secret guard could not check this output]", additionalContext: toolOutputReason(kinds, "withheld") } };
}

function checkedGuard(provider: Provider, event: HookEvent): HookDecision | undefined {
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
