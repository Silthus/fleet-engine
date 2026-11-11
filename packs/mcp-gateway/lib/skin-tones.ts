import { skinToneEmoji } from "./skin-tone-emoji.ts";

const codeSpans = /(```[\s\S]*?```|`[^`\n]*`)/;
const tonedShortcode = /:([a-z0-9_+-]+)::skin-tone-([2-6]):/g;
const lightestTone = "\u{1F3FB}";

const toned = (match: string, name: string, tone: string) => skinToneEmoji[name]?.replace(lightestTone, String.fromCodePoint(0x1f3f9 + Number(tone))) ?? match;

export function unicodeSkinTones(text: string) {
  return text.split(codeSpans).map((part, index) => (index % 2 ? part : part.replace(tonedShortcode, toned))).join("");
}

export function withUnicodeSkinTones(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, (key === "message" || key === "text") && typeof value === "string" ? unicodeSkinTones(value) : value]));
}
