import { reviewedDiff } from "./proof-review.ts";

type Result = { code: number; stdout: string; stderr: string };
export type Run = (command: string[]) => Result;

export type ReviewRange = { files: string[]; leftOut: string[]; diff: string };

export function reviewRange(run: Run, from: string, head: string, branched: string): ReviewRange {
  const changed = changedFiles(run, from, head);
  const own = from === branched ? new Set(changed) : new Set(changedFiles(run, branched, head));
  const files = changed.filter((file) => own.has(file));
  const leftOut = changed.filter((file) => !own.has(file));
  const diff = files.length ? diffOf(run, from, head, leftOut.length ? files : undefined) : "";
  return { files, leftOut, diff };
}

export const leftOutNote = (leftOut: string[]) =>
  leftOut.length ? `This diff holds only the files the PR changes against its base. It leaves out ${leftOut.length} file(s) that a merge of the base brought in.` : "";

function changedFiles(run: Run, from: string, to: string) {
  const result = run(["git", "diff", "--name-only", "--no-relative", from, to]);
  if (result.code !== 0) throw new Error(`Cannot list the files of ${short(from)}..${short(to)} here (${firstLine(result.stderr)})`);
  return result.stdout.split("\n").filter(Boolean);
}

function diffOf(run: Run, from: string, to: string, files?: string[]) {
  const paths = files ? ["--", ...files.map((file) => `:(top,literal)${file}`)] : [];
  const result = run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-relative", from, to, ...paths]);
  if (result.code !== 0) throw new Error(`Cannot diff ${short(from)}..${short(to)} here (${firstLine(result.stderr)})`);
  return reviewedDiff(result.stdout);
}

const short = (commit: string) => commit.slice(0, 7);
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
