export type DeltaKind = "test" | "revert";
export type QuietStep = { parent: string; kinds: DeltaKind[]; cancels?: { commit: string; parent: string } };
type Run = (command: string[]) => { code: number; stdout: string; stderr: string };
export type FileChange = { status: string; oldMode: string; newMode: string; oldBlob: string; newBlob: string; path: string };

const testFiles = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go)$/,
  /(^|\/)__snapshots__\/[^/]+\.snap$/,
];
export const isTestFile = (path: string) => testFiles.some((pattern) => pattern.test(path));
const regularFile = (mode: string) => mode === "100644" || mode === "100755";

const quietChange = ({ status, oldMode, newMode, path }: FileChange) => isTestFile(path) && (status === "D"
  ? regularFile(oldMode) && newMode === "000000"
  : regularFile(newMode) && ((status === "M" && oldMode === newMode) || (status === "A" && oldMode === "000000")));

export type CommitReader = {
  parents(commit: string): string[] | undefined;
  changes(from: string, to: string): FileChange[] | undefined;
  filesNaming(commit: string, text: string): string[] | undefined;
  message(commit: string): string | undefined;
  inBase(commit: string): boolean;
  isAncestor(ancestor: string, commit: string): boolean;
};

const importName = (path: string) => /_test\.go$/.test(path) || path.endsWith(".snap") ? undefined : path.split("/").at(-1)!.replace(/\.[cm]?[jt]sx?$|\.py$/, "");

function importedByCode(reader: CommitReader, commit: string, path: string) {
  const seen = new Set([path]);
  const queue = [path];
  while (queue.length) {
    const name = importName(queue.shift()!);
    if (name === undefined) continue;
    const naming = reader.filesNaming(commit, name);
    if (naming === undefined) return true;
    for (const file of naming) {
      if (!isTestFile(file)) return true;
      if (!seen.has(file)) { seen.add(file); queue.push(file); }
    }
  }
  return false;
}

const undoes = (revert: FileChange[], reverted: FileChange[]) => revert.length === reverted.length
  && revert.every((change) => reverted.some((done) => done.path === change.path && done.oldBlob === change.newBlob && done.newBlob === change.oldBlob && done.oldMode === change.newMode && done.newMode === change.oldMode));

function revertedPrCommit(reader: CommitReader, commit: string, parent: string, changes: FileChange[]) {
  const reverted = /^This reverts commit ([0-9a-f]{40})\b/m.exec(reader.message(commit) ?? "")?.[1];
  const parents = reverted ? reader.parents(reverted) : undefined;
  if (!reverted || parents?.length !== 1 || !reader.isAncestor(reverted, parent) || reader.inBase(reverted)) return undefined;
  const undone = reader.changes(parents[0]!, reverted);
  return undone !== undefined && undoes(changes, undone) ? { commit: reverted, parent: parents[0]! } : undefined;
}

export function quietStep(reader: CommitReader, commit: string): QuietStep | undefined {
  const parents = reader.parents(commit);
  if (parents?.length !== 1) return undefined;
  const parent = parents[0]!;
  const changes = reader.changes(parent, commit);
  if (!changes?.length) return undefined;
  const reverted = revertedPrCommit(reader, commit, parent, changes);
  if (reverted) return { parent, kinds: ["revert"], cancels: reverted };
  if (!changes.every(quietChange)) return undefined;
  if (changes.some((change) => importedByCode(reader, commit, change.path))) return undefined;
  return { parent, kinds: ["test"] };
}

const kindReasons: Record<DeltaKind, string> = { test: "test-only delta", revert: "revert of a PR commit" };
export const quietReason = (kinds: Iterable<DeltaKind>) => [...new Set(kinds)].map((kind) => kindReasons[kind]).join(" and ");

export function parseRawDiff(output: string): FileChange[] | undefined {
  const fields = output.split("\0");
  if (fields.pop() !== "") return undefined;
  const changes: FileChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(fields[index]!);
    const path = fields[index + 1];
    if (!match || !path) return undefined;
    changes.push({ oldMode: match[1]!, newMode: match[2]!, oldBlob: match[3]!, newBlob: match[4]!, status: match[5]!, path });
  }
  return changes;
}

export function gitCommitReader(run: Run, baseRefs: () => string[]): CommitReader {
  const output = (command: string[]) => { const result = run(command); return result.code === 0 ? result.stdout : undefined; };
  return {
    parents: (commit) => output(["git", "rev-list", "--parents", "-n", "1", commit])?.trim().split(" ").slice(1),
    changes: (from, to) => {
      const raw = output(["git", "diff", "--raw", "--no-renames", "--no-relative", "--no-abbrev", "--ignore-submodules=none", "--no-ext-diff", "--no-color", "-z", from, to]);
      return raw === undefined ? undefined : parseRawDiff(raw);
    },
    filesNaming: (commit, text) => {
      const result = run(["git", "grep", "--no-color", "-z", "-l", "-F", "-e", text, commit, "--", ":(top)"]);
      if (result.code === 1 && !result.stdout) return [];
      if (result.code !== 0) return undefined;
      return result.stdout.split("\0").filter(Boolean).map((hit) => hit.slice(commit.length + 1));
    },
    isAncestor: (ancestor, commit) => run(["git", "merge-base", "--is-ancestor", ancestor, commit]).code === 0,
    message: (commit) => output(["git", "log", "-1", "--format=%B", commit]),
    inBase: (commit) => {
      const refs = (() => { try { return baseRefs(); } catch { return []; } })();
      return !refs.length || refs.some((ref) => run(["git", "merge-base", "--is-ancestor", commit, ref]).code !== 1);
    },
  };
}

export const quietCommitIn = (run: Run, baseRefs: () => string[]) => {
  const reader = gitCommitReader(run, baseRefs);
  return (commit: string) => quietStep(reader, commit);
};
