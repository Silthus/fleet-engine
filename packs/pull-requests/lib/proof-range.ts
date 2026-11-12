import { reviewedDiff } from "./proof-review.ts";

type Result = { code: number; stdout: string; stderr: string };
export type Run = (command: string[]) => Result;

export type ReviewRange = { files: string[]; leftOut: string[]; diff: string };

export function reviewRange(run: Run, from: string, head: string, branched: string): ReviewRange {
  const changed = changedFiles(run, from, head);
  const own = from === branched ? undefined : new Set(changedFiles(run, branched, head).flat());
  const kept = changed.filter((paths) => !own || paths.some((path) => own.has(path)));
  const files = kept.map(last);
  const leftOut = changed.filter((paths) => !kept.includes(paths)).map(last);
  const diff = files.length ? diffOf(run, from, head, leftOut.length ? kept.flat() : undefined) : "";
  return { files, leftOut, diff };
}

export const leftOutNote = (leftOut: string[]) =>
  leftOut.length ? `This diff holds only the files the PR changes against its base. It leaves out ${leftOut.length} file(s) that a merge of the base brought in.` : "";

// Each entry holds a file's paths: one, or the old and new path of a rename or copy. -z keeps names unquoted.
function changedFiles(run: Run, from: string, to: string) {
  const result = run(["git", "diff", "--name-status", "-z", "--find-renames", "--no-relative", from, to]);
  if (result.code !== 0) throw new Error(`Cannot list the files of ${short(from)}..${short(to)} here (${firstLine(result.stderr)})`);
  const fields = result.stdout.split("\0");
  const entries: string[][] = [];
  for (let index = 0; index < fields.length && fields[index]; ) {
    const count = /^[RC]/.test(fields[index]!) ? 2 : 1;
    entries.push(fields.slice(index + 1, index + 1 + count));
    index += 1 + count;
  }
  return entries;
}

function diffOf(run: Run, from: string, to: string, files?: string[]) {
  const paths = files ? ["--", ...files.map((file) => `:(top,literal)${file}`)] : [];
  const result = run(["git", "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--no-relative", from, to, ...paths]);
  if (result.code !== 0) throw new Error(`Cannot diff ${short(from)}..${short(to)} here (${firstLine(result.stderr)})`);
  return reviewedDiff(result.stdout);
}

const last = (paths: string[]) => paths[paths.length - 1]!;
const short = (commit: string) => commit.slice(0, 7);
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
