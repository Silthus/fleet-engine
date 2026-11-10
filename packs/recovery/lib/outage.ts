import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writePrivateFile } from "../../../src/files/private.ts";
import { modelTable } from "../../base/lib/models.ts";
import { stringSetting } from "../../base/lib/settings.ts";
import { spawnText, threadModel, threadScript } from "../../hub/lib/hub-job.ts";

export type OutageEntry = { tries: number; triedAt?: string; alerted?: true };
export type OutageState = { version: 1; threads: Record<string, OutageEntry> };
export type RanOut = { name: string; error: string };

type Env = Record<string, string | undefined>;

const alertTimeoutMs = 600_000;
const statePath = (home: string) => join(home, ".local/state/fleet/outage-resume.json");

export function readOutageState(home: string): OutageState {
  try {
    const state = JSON.parse(readFileSync(statePath(home), "utf8")) as OutageState;
    const valid = state.version === 1 && typeof state.threads === "object" && state.threads !== null
      && Object.values(state.threads).every((entry) => Number.isInteger(entry?.tries) && (entry.triedAt === undefined || Number.isFinite(Date.parse(entry.triedAt))));
    return valid ? state : { version: 1, threads: {} };
  } catch {
    return { version: 1, threads: {} };
  }
}

export async function saveOutageState(home: string, state: OutageState): Promise<void> {
  const path = statePath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writePrivateFile(path, `${JSON.stringify(state)}\n`);
}

export async function alertOutages(threads: RanOut[], env: Env): Promise<boolean> {
  const count = threads.length === 1 ? "1 thread keeps" : `${threads.length} threads keep`;
  const list = threads.map((thread) => `- ${thread.name}: ${thread.error.slice(0, 200)}`).join("\n");
  const prompt = `Fleet continued these T3 threads after provider errors, four times each. Each try failed again, and Fleet stopped retrying them:
${list}

Run no commands and resume nothing. Reply in at most 10 lines: list the threads and their errors, and tell your user to resume them in T3 on this machine once the provider works.`;
  try {
    const fallback = modelTable(env)[0]?.model ?? "";
    const script = threadScript(stringSetting("hub.threadFolder", env), `${count} failing on provider errors`, threadModel("lookup", fallback, env));
    return (await spawnText(["sh", "-c", script], env, { stdin: prompt, timeoutMs: alertTimeoutMs })).code === 0;
  } catch {
    return false;
  }
}
