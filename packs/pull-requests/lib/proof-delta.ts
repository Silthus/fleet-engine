export type DeltaKind = "test";
export type QuietStep = { parent: string; kinds: DeltaKind[] };
type Run = (command: string[]) => { code: number; stdout: string; stderr: string };
export type FileChange = { status: string; oldMode: string; newMode: string; path: string };

const testFiles = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go)$/,
  /(^|\/)__snapshots__\/[^/]+\.snap$/,
];
export const isTestFile = (path: string) => testFiles.some((pattern) => pattern.test(path));
const regularFile = (mode: string) => mode === "100644" || mode === "100755";

const quietChange = ({ status, oldMode, newMode, path }: FileChange) => isTestFile(path) && regularFile(newMode)
  && ((status === "M" && oldMode === newMode) || (status === "A" && oldMode === "000000"));

export type CommitReader = {
  parents(commit: string): string[] | undefined;
  changes(from: string, to: string): FileChange[] | undefined;
};

export function quietStep(reader: CommitReader, commit: string): QuietStep | undefined {
  const parents = reader.parents(commit);
  if (parents?.length !== 1) return undefined;
  const parent = parents[0]!;
  const changes = reader.changes(parent, commit);
  if (!changes?.length || !changes.every(quietChange)) return undefined;
  return { parent, kinds: ["test"] };
}

export const quietReason = (_kinds: Iterable<DeltaKind>) => "test-only delta";

export function parseRawDiff(output: string): FileChange[] | undefined {
  const changes: FileChange[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*\t(.+)$/.exec(line);
    if (!match) return undefined;
    changes.push({ oldMode: match[1]!, newMode: match[2]!, status: match[3]!, path: match[4]! });
  }
  return changes;
}

export function gitCommitReader(run: Run): CommitReader {
  const output = (command: string[]) => { const result = run(command); return result.code === 0 ? result.stdout : undefined; };
  return {
    parents: (commit) => output(["git", "rev-list", "--parents", "-n", "1", commit])?.trim().split(" ").slice(1),
    changes: (from, to) => {
      const raw = output(["git", "-c", "core.quotePath=false", "diff", "--raw", "--no-renames", "--no-relative", "--no-abbrev", "-z", from, to]);
      return raw === undefined ? undefined : parseRawDiff(raw.replace(/\0(?=:|$)/g, "\n").replace(/\0/g, "\t"));
    },
  };
}

export const quietCommitIn = (run: Run) => {
  const reader = gitCommitReader(run);
  return (commit: string) => quietStep(reader, commit);
};
