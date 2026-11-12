import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lockedSince, tryLock } from "./lock.ts";
import { advanceSource, followsBranch, loadedCommit } from "./pack/sources.ts";
import type { AvailableSource, SourceRef } from "./pack/types.ts";

export type RefreshOptions = {
  home: string;
  cache: string;
  sources: SourceRef[];
  print: (line: string) => void;
  now: () => number;
  apply: (moved: AvailableSource[]) => Promise<boolean>;
};

/** Per source: the commit whose files a refresh applied, when its last fetch failed, and a rewritten commit it refused. */
type State = { applied: Record<string, string>; failed: Record<string, number>; refused: Record<string, string> };

const backOffMs = 30 * 60_000;
const lockAlarmMs = 30 * 60_000;

const statePath = (home: string) => join(home, ".local", "state", "fleet", "refresh.json");
const lockPath = (home: string) => join(home, ".local", "state", "fleet", "refresh.lock");

/** Returns 1 when something needs a person: a failed fetch, local edits, a rewritten branch, a failed apply, or a stuck refresh. */
export async function refresh(options: RefreshOptions): Promise<number> {
  const branches = await branchSources(options.sources, options.cache);
  if (!branches.length) return 0;
  const lock = lockPath(options.home);
  const held = tryLock(lock, options.now());
  if (!held) return busy(lock, options);
  try {
    return await refreshBranches(branches, options);
  } finally {
    held.release();
  }
}

function busy(lock: string, options: RefreshOptions) {
  const since = lockedSince(lock);
  const heldMs = since === undefined ? 0 : options.now() - since;
  if (heldMs < lockAlarmMs) return options.print("fleet refresh: another refresh still runs, so this one stops."), 0;
  options.print(`fleet refresh: another refresh has held ${lock} for ${Math.floor(heldMs / 60_000)} minutes. Stop that fleet refresh process; the next run then goes on.`);
  return 1;
}

async function branchSources(sources: SourceRef[], cache: string) {
  const follows = await Promise.all(sources.map((ref) => followsBranch(ref, cache)));
  return sources.filter((_, index) => follows[index]);
}

async function refreshBranches(branches: SourceRef[], options: RefreshOptions) {
  const state = await readState(options.home);
  const now = options.now();
  const moved: AvailableSource[] = [];
  const pending: Record<string, string> = {};
  let attention = false;
  const flag = (line: string) => {
    options.print(line);
    attention = true;
  };
  for (const ref of branches) {
    const from = await loadedCommit(ref, options.cache);
    if (!from) continue;
    state.applied[ref.name] ??= from;
    const failedAt = state.failed[ref.name];
    if (failedAt !== undefined && now - failedAt < backOffMs) {
      options.print(`${ref.name}: the last fetch failed, so Fleet tries again after ${new Date(failedAt + backOffMs).toISOString()}.`);
      continue;
    }
    const result = await advanceSource(ref, options.cache, from, state.refused[ref.name], now);
    switch (result.state) {
      case "busy":
        options.print(`${ref.name}: another Fleet run works in its cache, so the next refresh takes it.`);
        continue;
      case "edited":
        flag(result.say);
        continue;
      case "refused":
        flag(result.say);
        state.refused[ref.name] = result.commit;
        continue;
      case "failed":
        flag(result.say);
        state.failed[ref.name] = now;
        continue;
      case "moved":
        options.print(`${ref.name} moved to ${result.commit.slice(0, 12)}.`);
        moved.push(result.source);
    }
    delete state.failed[ref.name];
    delete state.refused[ref.name];
    if (state.applied[ref.name] !== result.commit) pending[ref.name] = result.commit;
  }
  await saveState(options.home, state);
  if (!Object.keys(pending).length) return attention ? 1 : 0;
  if (!(await options.apply(moved))) return 1;
  await saveState(options.home, { ...state, applied: { ...state.applied, ...pending } });
  return attention ? 1 : 0;
}

async function readState(home: string): Promise<State> {
  const saved = await readFile(statePath(home), "utf8").then((text) => JSON.parse(text) as Partial<State>, () => ({}) as Partial<State>);
  return { applied: saved.applied ?? {}, failed: saved.failed ?? {}, refused: saved.refused ?? {} };
}

async function saveState(home: string, state: State) {
  await mkdir(dirname(statePath(home)), { recursive: true });
  await writeFile(statePath(home), JSON.stringify(state) + "\n");
}
