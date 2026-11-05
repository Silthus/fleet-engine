import { redactSecrets } from "../../../base/hooks/secret-guard.ts";

const hidden = "[redacted credential]";
const secretWord = String.raw`(?:key|secret|token|passw(?:or)?d|pwd|credential|auth|cookie)`;
const secretName = String.raw`(?=[A-Za-z_])[A-Za-z0-9_.-]*?${secretWord}[A-Za-z0-9_.-]*`;
const secretKey = new RegExp(secretWord, "i");
const headerKey = /^(?:(?:proxy-)?authorization|(?:set-)?cookie|x-(?:.+-)?(?:key|token))$/i;
const credentialValue = String.raw`(?=[A-Za-z0-9._~+/=:-]*[0-9._~+/=-])[A-Za-z0-9._~+/=:-]{8,}`;
const notRedacted = String.raw`(?!\[redacted )`;
const nameStart = String.raw`(?<![A-Za-z0-9_.$])`;
const quotedValue = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'|\\"[\s\S]*?\\"`;
const assignedValue = String.raw`${quotedValue}|\$\([^)\n]*\)|\$\{[^}\n]*\}|[^\s"'&;,|<>\\()]+(?:\([^()"'\n]*\))?`;

const identifier = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;
const path = String.raw`${identifier}(?:\.${identifier})*`;
const codeReference = new RegExp(String.raw`^(?:${identifier}(?:\.${identifier})+|${path}\((?:${path}(?:\s*,\s*${path})*)?\)|\$${identifier}|\$\{${identifier}\}|\$\([\s\S]*\)|\[redacted [^\]]*\])?$`);
const unquoted = (value: string) => value.replace(/^(\\?["'])([\s\S]*)\1$/, "$2");
const keepsValue = (value: string) => codeReference.test(unquoted(value));
const quoteOf = (value: string) => /^(\\?["'])[\s\S]*\1$/.exec(value)?.[1] ?? "";

const hideValue = (match: string, before: string, value: string) =>
  keepsValue(value) ? match : `${before}${quoteOf(value)}${hidden}${quoteOf(value)}`;
const withoutQuotes = (match: string, before: string, value: string) => keepsValue(value) ? match : `${before}${hidden}`;

const credentialStart = String.raw`(?:[a-z]+\s+)?[A-Za-z0-9._~+/=:-]{8,}`;
const headerValueStart = String.raw`(?:(?<=cookie\s*:[ \t]*)[^\s;="'\\]+=|(?<=authorization\s*:[ \t]*)(?:bearer|basic|digest|token|negotiate)\s+\S|${credentialStart})`;
const headerName = String.raw`((?:proxy-)?authorization|(?:set-)?cookie)(\s*:[ \t]*)${notRedacted}(?=${headerValueStart})`;
const headerValueUntil: Array<[string, string]> = [[String.raw`\\"`, String.raw`(?:(?!\\")[^\r\n])*`], ['"', String.raw`[^"\r\n]*`], ["'", String.raw`[^'\r\n]*`], ["", String.raw`[^\r\n]*`]];
const wholeHeaders = headerValueUntil.map(([quote, value]): [RegExp, string] => [new RegExp(String.raw`(?<![\w-])(${quote})${headerName}${value}`, "gi"), `$1$2$3${hidden}`]);

const privateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

type Replacement = string | ((match: string, ...parts: string[]) => string);
const credentials: Array<[RegExp, Replacement]> = [
  [/^CREDENTIALS\t([^\t\n]+)\t([^\t\n]+)\t[^\t\n]+\t[^\t\n]+$/gm, `CREDENTIALS\t$1\t$2\t${hidden}\t${hidden}`],
  [/(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g, "[redacted AWS access key id]"],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted JWT]"],
  [new RegExp(String.raw`\b(aws[_-]secret[_-]access[_-]key|aws[_-]session[_-]token)(\s*[:=]\s*|\s+)${notRedacted}["']?[^\s"',]+["']?`, "gi"), `$1$2${hidden}`],
  ...wholeHeaders,
  [new RegExp(String.raw`\b(x-[a-z-]*(?:key|token|secret|auth)[a-z-]*|api-key)(\s*:\s*)(?:[a-z]+\s+)?[A-Za-z0-9._~+/=:-]{8,}`, "gi"), `$1$2${hidden}`],
  [new RegExp(String.raw`\b(bearer|basic)\s+${credentialValue}`, "gi"), `$1 ${hidden}`],
  [new RegExp(String.raw`(?<![\w-])(-u[ \t]*|--user(?:[ \t]+|=))(["']?)([^\s:"']+:)${notRedacted}[^\s"']+\2`, "g"), `$1$2$3${hidden}$2`],
  [new RegExp(String.raw`(^[ \t]*|\blogin[ \t]+\S+[ \t]+)(passw(?:or)?d[ \t]+)(?![=:])${notRedacted}(\S+)`, "gim"), `$1$2${hidden}`],
  [new RegExp(String.raw`(?<![\w-])(--${secretName}[ \t]+)(?!-)${notRedacted}(${assignedValue})`, "gi"), (match, before, value) => withoutQuotes(match, before!, value!)],
  [new RegExp(String.raw`${nameStart}((\\?["']?)${secretName}\2\s*:\s*)${notRedacted}(${quotedValue})`, "gi"), (match, before, _quote, value) => hideValue(match, before!, value!)],
  [new RegExp(String.raw`${nameStart}((\\?["'])${secretName}\2\s*:\s*)(-?\d[\d.eE+-]*|true|false)(?![\w.])`, "gi"), (_match, before, quote) => `${before}${quote}${hidden}${quote}`],
  [new RegExp(String.raw`^([ \t]*(?:-[ \t]+)?(["']?)${secretName}\2:[ \t]+)${notRedacted}([^\n]*[^\s])`, "gim"), (match, before, _quote, value) => withoutQuotes(match, before!, value!)],
  [new RegExp(String.raw`${nameStart}(${secretName}\s*=(?![=>~])\s*)${notRedacted}(${assignedValue})`, "gi"), (match, before, value) => withoutQuotes(match, before!, value!)],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:"']+:[^\s/?#@"']+@/gi, `$1${hidden}@`],
];

const redactPlain = (text: string) => credentials.reduce(
  (result, [pattern, replacement]) => typeof replacement === "string" ? result.replace(pattern, replacement) : result.replace(pattern, replacement),
  redactSecrets(text.replace(privateKey, "[redacted private key]")),
);

function decoded(text: string): unknown {
  if (!/^\s*[[{"]/.test(text)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && (typeof value === "object" || typeof value === "string") ? value : undefined;
  } catch {
    return undefined;
  }
}

function redactString(value: string, name: string): string {
  if (headerKey.test(name)) return hidden;
  if (secretKey.test(name) && !keepsValue(value)) return hidden;
  return redactCredentials(value);
}

const secretScalar = (value: unknown, name: string) =>
  (typeof value === "number" || typeof value === "boolean") && (headerKey.test(name) || secretKey.test(name));

export function redactValue(value: unknown, name = ""): unknown {
  if (secretScalar(value, name)) return hidden;
  if (typeof value === "string") return redactString(value, name);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, name));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry, key)]));
  return value;
}

export function redactCredentials(text: string): string {
  const json = decoded(text);
  return json === undefined ? redactPlain(text) : JSON.stringify(redactValue(json));
}
