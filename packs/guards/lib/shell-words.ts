import { basename } from "node:path";

const prefixes = new Set(["sudo", "env", "exec", "time", "nohup", "command", "builtin", "nice", "then", "do", "else", "!", "{", "("]);

function maskQuoted(text: string): string {
  let masked = "";
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && quote !== "'") {
      masked += index + 1 < text.length ? "__" : "_";
      index++;
    } else if (quote) {
      if (char === quote) quote = undefined;
      masked += "_";
    } else {
      if (char === "'" || char === '"') quote = char;
      masked += quote ? "_" : char;
    }
  }
  return masked;
}

function splitOutsideQuotes(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of maskQuoted(text).matchAll(separator)) {
    parts.push(text.slice(start, match.index));
    start = match.index + match[0].length;
  }
  return [...parts, text.slice(start)];
}

export const withoutHeredocs = (command: string) => command.replace(/<<-?\s*(["']?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "");
export const statements = (command: string) => splitOutsideQuotes(command, /&&|\|\||;|\n|(?<![>&<|])&(?![>&])/g);
export const pipeline = (statement: string) => splitOutsideQuotes(statement, /\|&?/g);
const words = (part: string) => part.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^["']+|["']+$/g, ""));

/** The words of one simple command, without prefixes such as `sudo`, `env A=1`, `timeout 5`, or `fleet heavy --`. */
export function commandWords(part: string): string[] {
  let rest = words(part);
  const heavy = rest.findIndex((word, index) => basename(word) === "fleet" && rest[index + 1] === "heavy");
  if (heavy >= 0 && rest.includes("--")) rest = rest.slice(rest.indexOf("--") + 1);
  while (rest.length > 0) {
    const [first, second] = rest;
    if (/^\w+=/.test(first) || prefixes.has(first) || (first.startsWith("-") && rest.length > 1)) rest = rest.slice(1);
    else if (first === "timeout" && second) rest = rest.slice(2);
    else break;
  }
  return rest.length > 0 ? [basename(rest[0]), ...rest.slice(1)] : [];
}

/** Every simple command of a Bash command line, as words, with heredoc bodies left out. */
export const simpleCommands = (command: string) => statements(withoutHeredocs(command)).flatMap((statement) => pipeline(statement).map(commandWords));
