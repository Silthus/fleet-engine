import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { advanceSource, followsBranch, loadedCommit } from "./pack/sources.ts";
import type { AvailableSource, SourceRef } from "./pack/types.ts";

export type RefreshOptions = {
  home: string;
  cache: string;
  sources: SourceRef[];
  print: (line: string) => void;
  apply: (moved: AvailableSource[]) => Promise<boolean>;
};

/** Per source: the commit whose files a refresh applied. */
type State = { applied: Record<string, string> };

const statePath = (home: string) => join(home, ".local", "state", "fleet", "refresh.json");

/** Returns 1 when something needs a person: a failed fetch, local edits, a rewritten branch, or a failed apply. */
export async function refresh(options: RefreshOptions): Promise<number> {
  const branches = await branchSources(options.sources, options.cache);
  if (!branches.length) return 0;
  return refreshBranches(branches, options);
}

async function branchSources(sources: SourceRef[], cache: string) {
  const follows = await Promise.all(sources.map((ref) => followsBranch(ref, cache)));
  return sources.filter((_, index) => follows[index]);
}

async function refreshBranches(branches: SourceRef[], options: RefreshOptions) {
  const state = await readState(options.home);
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
    const result = await advanceSource(ref, options.cache, from);
    switch (result.state) {
      case "busy":
        options.print(`${ref.name}: another Fleet run works in its cache, so the next refresh takes it.`);
        continue;
      case "edited":
        flag(result.say);
        continue;
      case "refused":
        flag(result.say);
        continue;
      case "failed":
        flag(result.say);
        continue;
      case "moved":
        options.print(`${ref.name} moved to ${result.commit.slice(0, 12)}.`);
        moved.push(result.source);
    }
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
  return { applied: saved.applied ?? {} };
}

async function saveState(home: string, state: State) {
  await mkdir(dirname(statePath(home)), { recursive: true });
  await writeFile(statePath(home), JSON.stringify(state) + "\n");
}
