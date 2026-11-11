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
  filesNaming(commit: string, text: string): string[] | undefined;
};

const importName = (path: string) => /_test\.go$/.test(path) || path.endsWith(".snap") ? undefined : path.split("/").at(-1)!.replace(/\.[cm]?[jt]sx?$|\.py$/, "");

function importedByCode(reader: CommitReader, commit: string, path: string) {
  const name = importName(path);
  if (name === undefined) return false;
  const naming = reader.filesNaming(commit, name);
  return naming === undefined || naming.some((file) => !isTestFile(file));
}

export function quietStep(reader: CommitReader, commit: string): QuietStep | undefined {
  const parents = reader.parents(commit);
  if (parents?.length !== 1) return undefined;
  const parent = parents[0]!;
  const changes = reader.changes(parent, commit);
  if (!changes?.length || !changes.every(quietChange)) return undefined;
  if (changes.some((change) => importedByCode(reader, commit, change.path))) return undefined;
  return { parent, kinds: ["test"] };
}

export const quietReason = (_kinds: Iterable<DeltaKind>) => "test-only delta";

export function parseRawDiff(output: string): FileChange[] | undefined {
  const fields = output.split("\0");
  if (fields.pop() !== "") return undefined;
  const changes: FileChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(fields[index]!);
    const path = fields[index + 1];
    if (!match || !path) return undefined;
    changes.push({ oldMode: match[1]!, newMode: match[2]!, status: match[3]!, path });
  }
  return changes;
}

export function gitCommitReader(run: Run): CommitReader {
  const output = (command: string[]) => { const result = run(command); return result.code === 0 ? result.stdout : undefined; };
  return {
    parents: (commit) => output(["git", "rev-list", "--parents", "-n", "1", commit])?.trim().split(" ").slice(1),
    changes: (from, to) => {
      const raw = output(["git", "diff", "--raw", "--no-renames", "--no-relative", "--no-abbrev", "--ignore-submodules=none", "--no-ext-diff", "-z", from, to]);
      return raw === undefined ? undefined : parseRawDiff(raw);
    },
    filesNaming: (commit, text) => {
      const result = run(["git", "grep", "-z", "-l", "-F", "-e", text, commit, "--"]);
      if (result.code === 1 && !result.stdout) return [];
      if (result.code !== 0) return undefined;
      return result.stdout.split("\0").filter(Boolean).map((hit) => hit.slice(commit.length + 1));
    },
  };
}

export const quietCommitIn = (run: Run) => {
  const reader = gitCommitReader(run);
  return (commit: string) => quietStep(reader, commit);
};
