import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const snapshotFile = (home: string) => join(home, ".local/state/fleet/settings.json");

const usage = "usage: fleet settings-snapshot [--check]";
const privateMode = 0o600;

export async function settingsSnapshotCommand(args: string[], home: string, settings: Record<string, unknown>): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error(usage);
  const file = snapshotFile(home);
  const wanted = `${JSON.stringify(settings, null, 2)}\n`;
  const current = await readPrivate(file);
  if (current === wanted) return 0;
  if (args[0] === "--check") return 1;
  await mkdir(dirname(file), { recursive: true });
  const draft = `${file}.${process.pid}.tmp`;
  await writeFile(draft, wanted, { mode: privateMode });
  await rename(draft, file);
  return 0;
}

async function readPrivate(file: string) {
  try {
    if (((await stat(file)).mode & 0o777) !== privateMode) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}
