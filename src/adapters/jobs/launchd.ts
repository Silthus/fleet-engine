import type { LaunchdTimer } from "./schedule.ts";

export const labelPrefix = "dev.fleet.";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const string = (value: string) => `<string>${escape(value)}</string>`;

function timer(value: LaunchdTimer) {
  if ("StartInterval" in value) return [`  <key>StartInterval</key>`, `  <integer>${value.StartInterval}</integer>`];
  const entries = Object.entries(value.StartCalendarInterval).flatMap(([key, number]) => [`    <key>${key}</key>`, `    <integer>${number}</integer>`]);
  return [`  <key>StartCalendarInterval</key>`, `  <dict>`, ...entries, `  </dict>`];
}

type Token = { open?: string; close?: string; text?: string };

const tokenPattern = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][\s\S]*?>|<(\/?)([A-Za-z]+)(?:\s[^>]*?)?\s*(\/?)>|([^<]+)/g;
const entities: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name: string) =>
    name.startsWith("#x") ? String.fromCodePoint(parseInt(name.slice(2), 16)) : name.startsWith("#") ? String.fromCodePoint(Number(name.slice(1))) : (entities[name] ?? whole),
  );
}

function tokens(text: string): Token[] {
  return [...text.matchAll(tokenPattern)].flatMap(([, cdata, slash, name, selfClosing, plain]): Token[] => {
    if (cdata !== undefined) return [{ text: cdata }];
    if (plain !== undefined) return [{ text: decode(plain) }];
    if (!name) return [];
    if (slash) return [{ close: name }];
    return selfClosing ? [{ open: name }, { close: name }] : [{ open: name }];
  });
}

export function labelOf(text: string) {
  const list = tokens(text);
  let depth = 0;
  let wantsValue = false;
  for (let index = 0; index < list.length; index++) {
    const token = list[index]!;
    if (token.open === "dict" || token.open === "array") {
      depth++;
      if (depth === 2) wantsValue = false;
      continue;
    }
    if (token.close === "dict" || token.close === "array") {
      if (--depth === 0) return undefined;
      continue;
    }
    if (depth !== 1 || !token.open) continue;
    const end = list.findIndex((item, at) => at > index && item.close === token.open);
    const content = list.slice(index + 1, end === -1 ? list.length : end).map((item) => item.text ?? "").join("");
    if (token.open === "key") wantsValue = content === "Label";
    else if (wantsValue) return token.open === "string" ? content : undefined;
    if (end !== -1) index = end;
  }
  return undefined;
}

export function plist(id: string, script: string, schedule: LaunchdTimer, log: string) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  ${string(`${labelPrefix}${id}`)}`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    ${string("/bin/sh")}`,
    `    ${string(script)}`,
    `  </array>`,
    ...timer(schedule),
    `  <key>StandardOutPath</key>`,
    `  ${string(log)}`,
    `  <key>StandardErrorPath</key>`,
    `  ${string(log)}`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}
