/** A text that names this machine or its owner, and the label that replaces it. */
export type KnownName = { text: string; as: string };

type Rule = [RegExp, string | ((match: string, ...groups: Array<string | number | undefined>) => string)];

const secretKey = String.raw`[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|SESSION)[A-Za-z_]*`;

const rules: Rule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "<private key>"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "<token>"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "<key>"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g, "<token>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<key>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<token>"],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 <token>"],
  [/((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1<credentials>@"],
  [/([?&#][A-Za-z_]*(?:token|key|secret|password|auth|code|sig)[A-Za-z_]*=)[^\s&#"']+/gi, "$1<redacted>"],
  [new RegExp(String.raw`\b(${secretKey})(["']?\s*[:=]\s*)(?:(")(?:[^"\\]|\\.){0,4096}"|(')[^']{0,4096}'|[^\s"']+)`, "gi"), (_match, key, separator, double, single) => `${key}${separator}${double ?? single ?? ""}<redacted>${double ?? single ?? ""}`],
  [/(?<![\w.+%-])[\w.+%-]+(?:@|%40)[A-Za-z0-9-]+(?:(?:\.|%2E)[A-Za-z0-9-]+)*(?:\.|%2E)[A-Za-z]{2,}\b/gi, (email, offset, text) => (email.startsWith("git@") && String(text)[Number(offset) + email.length] === ":" ? email : "<email>")],
  [/(?<![\w.-])[\w.-]+\/fleet-(profile|memory)(?:-[\w-]+)?\b/g, "<$1 repo>"],
  [/(private repos? )[\w.-]+\/[\w.-]+(?: and [\w.-]+\/[\w.-]+)?/g, "$1<private repo>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip: string) => (ip === "127.0.0.1" || ip === "0.0.0.0" ? ip : "<ip>")],
  [/(?<![A-Za-z0-9-]|[A-Za-z0-9-]\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:internal|local|lan|corp|home\.arpa|coder|ts\.net|tailscale\.net)\b/g, "<host>"],
  [/(\/Users|\/home)\/(?:[^/\n"'`:]{1,64}?(?=\/)|[^/\s"'`:]+)/g, "$1/<user>"],
  [/\b([A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))(?:[^\\/\n"'`:]{1,64}?(?=[\\/])|[^\\/\s"'`:]+)/gi, "$1<user>"],
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, (text) => (looksRandom(text) ? "<secret>" : text)],
];

const tokenLetters = 32;
const windowLetters = 128;

type Tally = { letters: number; upper: number };

function looksRandom(text: string) {
  if (!/[A-Z]/.test(text) || !/[a-z]/.test(text)) return false;
  if (/[0-9]/.test(text)) return true;
  const parts: Tally[] = text
    .replace(/=+$/, "")
    .split(/[+/_-]/)
    .filter((part) => /[A-Z]/.test(part) && /[a-z]/.test(part))
    .map((part) => ({ letters: part.length, upper: part.match(/[A-Z]/g)!.length }));
  if (evenCases(parts.reduce(add, { letters: 0, upper: 0 }))) return true;
  for (let start = 0; start < parts.length; start++) {
    let window: Tally = { letters: 0, upper: 0 };
    for (let end = start; end < parts.length && window.letters - parts[start]!.letters < windowLetters; end++) {
      window = add(window, parts[end]!);
      if (evenCases(window)) return true;
    }
  }
  return false;
}

const add = (a: Tally, b: Tally): Tally => ({ letters: a.letters + b.letters, upper: a.upper + b.upper });

function evenCases({ letters, upper }: Tally) {
  return letters >= tokenLetters && Math.min(upper, letters - upper) * 4 >= letters;
}

/**
 * Removes what must not leave the machine in a report: keys, tokens, private
 * keys, passwords in URLs, email addresses, IP addresses, private hostnames,
 * the home path, and the names the caller knows, such as this machine's
 * hostname and its devboxes.
 */
export function redact(text: string, home: string, known: KnownName[] = []): string {
  let result = text;
  const spellings = known.filter((entry) => entry.text.length >= 2).flatMap((entry) => [...new Set([entry.text, encodeURIComponent(entry.text), entry.text.replace(/ /g, "+")])].map((text) => ({ text, as: entry.as })));
  for (const name of spellings.sort((a, b) => b.text.length - a.text.length)) {
    result = result.replace(new RegExp(`(?<![\\w-])${escape(name.text)}(?![\\w-])`, name.text.length < 4 ? "g" : "gi"), name.as);
  }
  if (home.length > 1) result = result.split(home.replace(/\/$/, "")).join("~");
  for (const [pattern, replacement] of rules) result = result.replace(pattern, replacement as string);
  return result;
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
