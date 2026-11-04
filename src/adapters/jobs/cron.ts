export const marker = (id: string) => `# fleet:${id}`;
const markedLine = /\s# fleet:([A-Za-z0-9._-]+)$/;

export function shellQuote(value: string) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function cronLine(id: string, expression: string, command: string[], path: string, log: string) {
  const text = [`PATH=${shellQuote(path)}`, ...command.map(shellQuote), `>>${shellQuote(log)}`, "2>&1"].join(" ");
  return `${expression} ${text.replaceAll("%", "\\%")} ${marker(id)}`;
}

export type CronChanges = { text: string; added: string[]; changed: string[]; removed: string[] };

export function reconcileCrontab(current: string, wanted: Map<string, string>, keepOthers = false): CronChanges {
  const lines = current.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const seen = new Set<string>();
  const result: CronChanges = { text: "", added: [], changed: [], removed: [] };
  const kept = lines.flatMap((line) => {
    const id = line.match(markedLine)?.[1];
    if (id === undefined) return [line];
    const next = wanted.get(id) ?? (keepOthers && !seen.has(id) ? line : undefined);
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
