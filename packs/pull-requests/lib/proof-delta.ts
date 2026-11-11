export type DeltaKind = "test" | "comment";
export type QuietStep = { parent: string; kinds: DeltaKind[] };
type Language = "js" | "go" | "python";
type Run = (command: string[]) => { code: number; stdout: string; stderr: string };

const testPaths = [
  /(^|\/)(__tests__|__snapshots__|__mocks__|tests?|testdata)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go)$/,
  /(^|\/)conftest\.py$/,
  /\.snap$/,
];
export const isTestPath = (path: string) => testPaths.some((pattern) => pattern.test(path));

function languageOf(path: string): Language | undefined {
  if (/\.[cm]?[jt]sx?$/.test(path)) return "js";
  if (/\.go$/.test(path)) return "go";
  if (/\.pyi?$/.test(path)) return "python";
}

const regexFollows = /(^|[(,=:[!&|?{};+\-*%<>~^])$|(^|[^\w$])(return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/;

export function codeLines(source: string, language: Language): string[] {
  const lines = [""];
  const emit = (text: string) => {
    const [first, ...rest] = text.split("\n");
    lines[lines.length - 1] += first;
    lines.push(...rest);
  };
  const lineComment = language === "python" ? "#" : "//";
  const templateDepths: number[] = [];
  let depth = 0;
  let index = 0;
  const take = (end: number) => { emit(source.slice(index, end)); index = end; };
  const stringEnd = (close: string, from: number, { escapes = true, multiline = false, template = false } = {}) => {
    let end = from;
    while (end < source.length) {
      if (escapes && source[end] === "\\") { end += 2; continue; }
      if (source.startsWith(close, end)) return end + close.length;
      if (template && source.startsWith("${", end)) { templateDepths.push(depth); return end + 2; }
      if (!multiline && source[end] === "\n") return end;
      end++;
    }
    return source.length;
  };
  const regexEnd = (from: number) => {
    let end = from;
    let inClass = false;
    while (end < source.length && source[end] !== "\n") {
      const char = source[end]!;
      if (char === "\\") { end += 2; continue; }
      if (char === "/" && !inClass) return end + 1;
      if (char === "[") inClass = true;
      if (char === "]") inClass = false;
      end++;
    }
    return end;
  };
  while (index < source.length) {
    const char = source[index]!;
    const triple = source.slice(index, index + 3);
    if (source.startsWith(lineComment, index)) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
    } else if (language !== "python" && source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      const end = close < 0 ? source.length : close + 2;
      emit(source.slice(index, end).replace(/[^\n]/g, ""));
      index = end;
    } else if (language === "python" && (triple === '"""' || triple === "'''")) take(stringEnd(triple, index + 3, { multiline: true }));
    else if (char === '"' || char === "'") take(stringEnd(char, index + 1));
    else if (char === "`" && language === "js") take(stringEnd("`", index + 1, { multiline: true, template: true }));
    else if (char === "`" && language === "go") take(stringEnd("`", index + 1, { escapes: false, multiline: true }));
    else if (char === "/" && language === "js" && regexFollows.test(lines.at(-1)!.trimEnd())) take(regexEnd(index + 1));
    else if (char === "}" && language === "js" && templateDepths.at(-1) === depth) {
      templateDepths.pop();
      take(stringEnd("`", index + 1, { multiline: true, template: true }));
    } else {
      if (language === "js" && char === "{") depth++;
      if (language === "js" && char === "}") depth--;
      take(index + 1);
    }
  }
  return lines.map((line) => line.trim());
}

function changedLines(diff: string) {
  const removed: number[] = [];
  const added: number[] = [];
  const range = (start: string, count: string | undefined) => Array.from({ length: Number(count ?? 1) }, (_, offset) => Number(start) + offset);
  for (const [, oldStart, oldCount, newStart, newCount] of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    removed.push(...range(oldStart!, oldCount));
    added.push(...range(newStart!, newCount));
  }
  return { removed, added };
}

export function onlyCommentsChanged(path: string, before: string, after: string, diff: string) {
  const language = languageOf(path);
  if (!language) return false;
  const [old, next] = [codeLines(before, language), codeLines(after, language)];
  const { removed, added } = changedLines(diff);
  if (!removed.length && !added.length) return false;
  if (removed.some((line) => old[line - 1] !== "") || added.some((line) => next[line - 1] !== "")) return false;
  const code = (lines: string[]) => lines.filter(Boolean).join("\n");
  return code(old) === code(next);
}

export type CommitReader = {
  parents(commit: string): string[] | undefined;
  changedFiles(from: string, to: string): string[] | undefined;
  file(commit: string, path: string): string | undefined;
  diff(from: string, to: string, path: string): string | undefined;
};

export function quietStep(reader: CommitReader, commit: string): QuietStep | undefined {
  const parents = reader.parents(commit);
  if (parents?.length !== 1) return undefined;
  const parent = parents[0]!;
  const files = reader.changedFiles(parent, commit);
  if (!files?.length) return undefined;
  const kinds = new Set<DeltaKind>();
  for (const path of files) {
    if (isTestPath(path)) { kinds.add("test"); continue; }
    const [before, after, diff] = [reader.file(parent, path), reader.file(commit, path), reader.diff(parent, commit, path)];
    if (before === undefined || after === undefined || diff === undefined || !onlyCommentsChanged(path, before, after, diff)) return undefined;
    kinds.add("comment");
  }
  return { parent, kinds: [...kinds] };
}

export const quietReason = (kinds: Iterable<DeltaKind>) => {
  const found = new Set(kinds);
  if (found.size === 2) return "test-only and comment-only delta";
  return found.has("test") ? "test-only delta" : "comment-only delta";
};

export function gitCommitReader(run: Run): CommitReader {
  const output = (command: string[]) => { const result = run(command); return result.code === 0 ? result.stdout : undefined; };
  return {
    parents: (commit) => output(["git", "rev-list", "--parents", "-n", "1", commit])?.trim().split(" ").slice(1),
    changedFiles: (from, to) => output(["git", "diff", "--name-only", "--no-renames", "--no-relative", from, to])?.split("\n").filter(Boolean),
    file: (commit, path) => {
      const result = run(["git", "show", "--no-textconv", `${commit}:${path}`]);
      if (result.code === 0) return result.stdout;
      return /does not exist|exists on disk, but not in/.test(result.stderr) ? "" : undefined;
    },
    diff: (from, to, path) => output(["git", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", from, to, "--", `:(top,literal)${path}`]),
  };
}

export const quietCommitIn = (run: Run) => {
  const reader = gitCommitReader(run);
  return (commit: string) => quietStep(reader, commit);
};
