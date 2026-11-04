import type { LaunchdTimer } from "./schedule.ts";

export const labelPrefix = "dev.fleet.";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const string = (value: string) => `<string>${escape(value)}</string>`;

function timer(value: LaunchdTimer) {
  if ("StartInterval" in value) return [`  <key>StartInterval</key>`, `  <integer>${value.StartInterval}</integer>`];
  const entries = Object.entries(value.StartCalendarInterval).flatMap(([key, number]) => [`    <key>${key}</key>`, `    <integer>${number}</integer>`]);
  return [`  <key>StartCalendarInterval</key>`, `  <dict>`, ...entries, `  </dict>`];
}

export function labelOf(text: string) {
  return text.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
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
