/** A text that names this machine or its owner, and the label that replaces it. */
export type KnownName = { text: string; as: string };

type Rule = [RegExp, string | ((match: string, ...groups: string[]) => string)];

const secretKey = String.raw`[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|SESSION)[A-Za-z_]*`;

const rules: Rule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "<private key>"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "<token>"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "<key>"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g, "<token>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<key>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<token>"],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 <token>"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1<credentials>@"],
  [/([?&#][A-Za-z_]*(?:token|key|secret|password|auth|code|sig)[A-Za-z_]*=)[^\s&#"']+/gi, "$1<redacted>"],
  [new RegExp(String.raw`\b(${secretKey})(["']?\s*[:=]\s*)(?:(")(?:[^"\\\n]|\\.)*"|(')[^'\n]*'|[^\s"']+)`, "gi"), (_match, key: string, separator: string, double?: string, single?: string) => `${key}${separator}${double ?? single ?? ""}<redacted>${double ?? single ?? ""}`],
  [/\b[\w.+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gi, (email) => (email.startsWith("git@") ? email : "<email>")],
  [/\b[\w.-]+\/fleet-profile(?:-[\w-]+)?\b/g, "<profile repo>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => (ip === "127.0.0.1" || ip === "0.0.0.0" ? ip : "<ip>")],
  [/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:internal|local|lan|corp|home\.arpa|coder|ts\.net|tailscale\.net)\b/g, "<host>"],
  [/(\/Users|\/home)\/[^/\s"'`:]+/g, "$1/<user>"],
  [/\b([A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))[^\\/\s"'`:]+/gi, "$1<user>"],
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, (text) => (/^[0-9a-f]+$/.test(text) || !/[A-Z]/.test(text) || !/[a-z]/.test(text) || !/[0-9]/.test(text) ? text : "<secret>")],
];

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
