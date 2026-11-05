import { quote } from "./launcher.ts";

export const marker = (id: string) => `# fleet:${id}`;
const markedLine = /\s# fleet:([A-Za-z0-9._-]+)$/;

export const cronSafe = (path: string) => !/[%\n\r]/.test(path);

export function cronLine(id: string, expression: string, script: string) {
  if (!cronSafe(script)) throw new Error(`cron cannot run ${script}: the path holds a percent sign or a line break`);
  return `${expression} /bin/sh ${quote(script)} ${marker(id)}`;
}

export type CronChanges = { text: string; added: string[]; changed: string[]; removed: string[] };

export function reconcileCrontab(current: string, wanted: Map<string, string>, keepOthers: boolean | Set<string> = false): CronChanges {
  const keeps = (id: string) => keepOthers === true || (keepOthers instanceof Set && keepOthers.has(id));
  const lines = current.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const seen = new Set<string>();
  const result: CronChanges = { text: "", added: [], changed: [], removed: [] };
  const kept = lines.flatMap((line) => {
    const id = line.match(markedLine)?.[1];
    if (id === undefined) return [line];
    const next = wanted.get(id) ?? (keeps(id) && !seen.has(id) ? line : undefined);
    if (next === undefined || seen.has(id)) {
      result.removed.push(id);
      return [];
    }
    seen.add(id);
    if (next !== line) result.changed.push(id);
    return [next];
  });
  for (const [id, line] of wanted) {
    if (seen.has(id)) continue;
    kept.push(line);
    result.added.push(id);
  }
  result.text = kept.length ? `${kept.join("\n")}\n` : "";
  return result;
}
