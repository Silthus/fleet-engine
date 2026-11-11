import { skinToneEmoji } from "./skin-tone-emoji.ts";

const codeOrTonedShortcode = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|:([a-z0-9_+-]+)::skin-tone-([2-6]):/g;
const lightestTone = "\u{1F3FB}";

function toned(match: string, code: string | undefined, name: string, tone: string) {
  if (code !== undefined || !Object.hasOwn(skinToneEmoji, name)) return match;
  return skinToneEmoji[name]!.replaceAll(lightestTone, String.fromCodePoint(0x1f3f9 + Number(tone)));
}

export function unicodeSkinTones(text: string) {
  return text.replace(codeOrTonedShortcode, toned);
}

export function withUnicodeSkinTones(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, (key === "message" || key === "text") && typeof value === "string" ? unicodeSkinTones(value) : value]));
}
