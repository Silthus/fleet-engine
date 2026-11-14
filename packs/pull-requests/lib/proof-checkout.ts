import { readPullRequest, type Run } from "./pr-ci.ts";
import { reviewedDiff } from "./proof-review.ts";
import { isTestFile } from "./proof-delta.ts";
import { riskCalloutOf } from "./decision-ledger.ts";
import type { CleanBaseMerge, ProofIdentity } from "./proof.ts";

const short = (commit: string) => commit.slice(0, 7);
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

export function topLevel(run: Run) {
  const result = run(["git", "rev-parse", "--show-toplevel"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export function mergeBase(identity: ProofIdentity, run: Run) {
  for (const ref of baseRefs(identity, run)) {
    const result = run(["git", "merge-base", ref, identity.commit]);
    if (result.code === 0) return result.stdout.trim();
  }
  throw new Error(`Cannot find where ${identity.repository}#${identity.pr} branched from its base here. Fetch the base branch from a remote of ${identity.repository}`);
}

export function baseTip(identity: ProofIdentity, run: Run) {
  for (const ref of baseRefs(identity, run)) {
    const result = run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (result.code === 0) return result.stdout.trim();
  }
  throw new Error(`Cannot find the base branch of ${identity.repository}#${identity.pr} here. Fetch it from a remote of ${identity.repository}`);
}

export function diffOf(from: string, to: string, run: Run) {
  const diff = run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-relative", from, to]);
  if (diff.code !== 0) throw new Error(`Cannot diff ${short(from)}..${short(to)} here (${firstLine(diff.stderr)})`);
  return reviewedDiff(diff.stdout);
}

const docsFile = /\.(md|mdx|markdown|rst)$/i;
const lockFile = /(^|\/)([^/]+\.lockb?|package-lock\.json|pnpm-lock\.yaml|go\.sum)$/;
const smallLines = 50;

const mergeRiskOf = (body: string) => /Merge risk:\**\s*(low|medium|high)\b/i.exec(riskCalloutOf(body) ?? "")?.[1]?.toLowerCase();

export function smallPr(identity: ProofIdentity, run: Run, body: string) {
  const from = baseRefs(identity, run).map((ref) => run(["git", "merge-base", ref, identity.commit])).find((result) => result.code === 0)?.stdout.trim();
  const stat = from ? run(["git", "diff", "--numstat", "-z", "--no-renames", "--no-relative", from, identity.commit]) : undefined;
  if (stat?.code !== 0) return false;
  const files = stat.stdout.split("\0").filter(Boolean).map((entry) => {
    const [added = "", deleted = "", path = ""] = entry.split("\t");
    return { lines: Number(added) + Number(deleted), path };
  });
  if (!files.length) return false;
  if (files.every(({ path }) => docsFile.test(path))) return true;
  const authored = files.filter(({ path }) => !isTestFile(path) && !lockFile.test(path)).reduce((sum, { lines }) => sum + lines, 0);
  return authored < smallLines && mergeRiskOf(body) === "low";
}

export function pullRequestDetails(identity: ProofIdentity, run: Run) {
  try {
    const { title, body, base } = readPullRequest(identity, run);
    return { title, body, baseRefName: base };
  } catch (error) {
    throw new Error(`Cannot read ${identity.repository}#${identity.pr} over GitHub's REST API (${(error as Error).message})`);
  }
}

export function baseRefs(identity: ProofIdentity, run: Run) {
  const base = pullRequestDetails(identity, run).baseRefName;
  return remotesOf(identity.repository, run).map((remote) => `refs/remotes/${remote}/${base}`);
}

export function remotesOf(repository: string, run: Run) {
  const remotes = run(["git", "remote"]).stdout.split("\n").filter(Boolean);
  return remotes.filter((remote) => new RegExp(`github\\.com[:/]${repository.replace(/\./g, "\\.")}(\\.git)?/?$`, "i").test(run(["git", "remote", "get-url", remote]).stdout.trim()));
}

export function cleanBaseMerge(identity: ProofIdentity, run: Run): CleanBaseMerge {
  let bases: string[] | undefined;
  return (commit) => {
    const parents = run(["git", "rev-list", "--parents", "-n", "1", commit]);
    const [, reviewedSide, baseSide, ...more] = parents.code === 0 ? parents.stdout.trim().split(" ") : [];
    if (!reviewedSide || !baseSide || more.length) return undefined;
    bases ??= baseRefs(identity, run);
    if (!bases.some((ref) => run(["git", "merge-base", "--is-ancestor", baseSide, ref]).code === 0)) return undefined;
    const remerge = run(["git", "show", "--remerge-diff", "--format=", "--no-relative", "--no-ext-diff", "--no-textconv", commit]);
    return remerge.code === 0 && !remerge.stdout.trim() ? reviewedSide : undefined;
  };
}
