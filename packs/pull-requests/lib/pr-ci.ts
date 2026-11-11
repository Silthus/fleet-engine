import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CiResult, ProofIdentity, PushedHead } from "./proof.ts";

export type Run = (command: string[]) => { code: number; stdout: string; stderr: string };
export type PullRequest = { title: string; body: string; draft: boolean; head: string; base: string; defaultBranch?: string };

type CheckRun = { id: number; name: string; status: string; conclusion: string | null; app?: number | null };
type CommitStatus = { context: string; state: string };
type RequiredCheck = { context: string; appId?: number };
type Outcome = "pass" | "fail" | "pending";
type Entry = { name: string; outcome: Outcome; appId?: number; status?: true };

const passing = new Set(["success", "neutral", "skipped"]);
const rank: Record<Outcome, number> = { pass: 0, pending: 1, fail: 2 };
const cacheMs = 60 * 60_000;
const short = (commit: string) => commit.slice(0, 7);
const firstLine = (text: string) => text.trim().split("\n")[0] || "no output";

function restJson<T>(path: string, run: Run): T {
  const result = run(["gh", "api", path]);
  if (result.code !== 0) throw new Error(`gh api ${path.split("?")[0]} failed (${firstLine(result.stderr)})`);
  return JSON.parse(result.stdout) as T;
}

export function readPullRequest(identity: ProofIdentity, run: Run): PullRequest {
  type Raw = { title?: string; body?: string | null; draft?: boolean; head?: { sha?: string }; base?: { ref?: string; repo?: { default_branch?: string } } };
  const raw = restJson<Raw>(`repos/${identity.repository}/pulls/${identity.pr}`, run);
  return { title: raw.title ?? "", body: raw.body ?? "", draft: raw.draft === true, head: raw.head?.sha ?? "", base: raw.base?.ref ?? "", defaultBranch: raw.base?.repo?.default_branch };
}

export function pushedHeadOf(identity: ProofIdentity, run: Run): PushedHead {
  try { return { commit: readPullRequest(identity, run).head }; }
  catch (error) { return { error: (error as Error).message }; }
}

function readRequired(repository: string, branch: string, run: Run): RequiredCheck[] {
  const checks = new Map<string, RequiredCheck>();
  const add = (context: string, appId?: number | null) => checks.set(`${context}\n${appId ?? ""}`, appId ? { context, appId } : { context });
  type Rule = { type: string; parameters?: { required_status_checks?: { context: string; integration_id?: number }[] } };
  const encoded = encodeURIComponent(branch);
  for (let page = 1; ; page++) {
    const rules = run(["gh", "api", `repos/${repository}/rules/branches/${encoded}?per_page=100&page=${page}`]);
    if (rules.code !== 0) {
      if (page === 1 && /HTTP 404|Upgrade to GitHub/.test(rules.stderr)) break;
      throw new Error(`cannot read the rulesets of ${branch} over REST (${firstLine(rules.stderr)})`);
    }
    const list = JSON.parse(rules.stdout) as Rule[];
    for (const rule of list) if (rule.type === "required_status_checks") for (const check of rule.parameters?.required_status_checks ?? []) add(check.context, check.integration_id);
    if (list.length < 100) break;
  }
  type Branch = { protection?: { required_status_checks?: { enforcement_level?: string; contexts?: string[]; checks?: { context: string; app_id?: number | null }[] } } };
  const branchView = run(["gh", "api", `repos/${repository}/branches/${encoded}`]);
  if (branchView.code !== 0) throw new Error(`cannot read the protection of ${branch} over REST (${firstLine(branchView.stderr)})`);
  const classic = (JSON.parse(branchView.stdout) as Branch).protection?.required_status_checks;
  if (classic && classic.enforcement_level !== "off") {
    for (const check of classic.checks ?? []) add(check.context, check.app_id);
    for (const context of classic.contexts ?? []) if (![...checks.values()].some((check) => check.context === context)) add(context);
  }
  return [...checks.values()];
}

function requiredChecks(home: string, repository: string, branch: string, run: Run, now: Date): RequiredCheck[] {
  const path = join(home, ".local/state/fleet/required-checks", repository, `${encodeURIComponent(branch)}.json`);
  try {
    const cached = JSON.parse(readFileSync(path, "utf8")) as { fetchedAt: string; checks: RequiredCheck[] };
    const age = now.getTime() - new Date(cached.fetchedAt).getTime();
    if (age >= 0 && age < cacheMs) return cached.checks;
  } catch {}
  const checks = readRequired(repository, branch, run);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ fetchedAt: now.toISOString(), checks }));
  return checks;
}

function commitRecords<T>(identity: ProofIdentity, run: Run, path: string, jq: string): T[] {
  const result = run(["gh", "api", "--paginate", `repos/${identity.repository}/commits/${identity.commit}/${path}?per_page=100`, "--jq", jq]);
  if (result.code !== 0) throw new Error(`gh api ${path} failed (${firstLine(result.stderr)})`);
  try { return result.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T); }
  catch { throw new Error(`gh api ${path} printed no JSON lines`); }
}

function entriesOf(identity: ProofIdentity, run: Run): Entry[] {
  const runs = commitRecords<CheckRun>(identity, run, "check-runs", ".check_runs[] | {id, name, status, conclusion, app: .app.id}");
  const newestRuns = [...runs.reduce((newest, check) => {
    const key = `${check.name}\n${check.app ?? ""}`;
    if ((newest.get(key)?.id ?? -1) < check.id) newest.set(key, check);
    return newest;
  }, new Map<string, CheckRun>()).values()];
  const statuses = commitRecords<CommitStatus>(identity, run, "statuses", ".[] | {context, state}");
  const newest = statuses.filter((status, index) => statuses.findIndex((other) => other.context === status.context) === index);
  return [
    ...newestRuns.map((check): Entry => ({ name: check.name, appId: check.app ?? undefined, outcome: check.status !== "completed" ? "pending" : passing.has(check.conclusion ?? "") ? "pass" : "fail" })),
    ...newest.map((status): Entry => ({ name: status.context, status: true, outcome: status.state === "success" ? "pass" : status.state === "pending" ? "pending" : "fail" })),
  ];
}

function listOf(names: string[], limit = 8) {
  const unique = [...new Set(names)];
  return unique.length > limit ? `${unique.slice(0, limit).join(", ")} and ${unique.length - limit} more` : unique.join(", ");
}

const reportedBy = (check: RequiredCheck, entry: Entry) => check.appId === undefined || (!entry.status && entry.appId === check.appId);

function withheldFromDraft(check: RequiredCheck, entries: Entry[]) {
  const split = check.context.indexOf(" / ");
  if (split <= 0 || entries.some((entry) => entry.name === check.context)) return false;
  const siblings = entries.filter((entry) => entry.name.startsWith(check.context.slice(0, split + 3)) && reportedBy(check, entry));
  return siblings.length > 0 && siblings.every((entry) => entry.outcome === "pass");
}

function everyCheck(entries: Entry[], commit: string): CiResult {
  if (!entries.length) return { state: "none", detail: `no checks reported on ${short(commit)}` };
  const named = (outcome: Outcome) => entries.filter((entry) => entry.outcome === outcome).map((entry) => entry.name);
  const [failing, pending] = [named("fail"), named("pending")];
  if (failing.length) return { state: "red", detail: `failing: ${listOf(failing)}` };
  if (pending.length) return { state: "pending", detail: `waiting on: ${listOf(pending)}` };
  return { state: "green", detail: `${entries.length} check(s) on ${short(commit)}` };
}

function notRequired(entries: Entry[]) {
  const failing = entries.filter((entry) => entry.outcome === "fail").map((entry) => entry.name);
  const running = new Set(entries.filter((entry) => entry.outcome === "pending").map((entry) => entry.name)).size;
  const parts = [failing.length ? `failing: ${listOf(failing)}` : "", running ? `${running} still running` : ""].filter(Boolean);
  return parts.length ? `; not required: ${parts.join("; ")}` : "";
}

function requiredVerdict(entries: Entry[], required: RequiredCheck[], draft: boolean): CiResult {
  const counted = new Set<Entry>();
  const [failing, pending, missing, withheld]: string[][] = [[], [], [], []];
  for (const check of required) {
    const matches = entries.filter((entry) => entry.name === check.context && reportedBy(check, entry));
    matches.forEach((entry) => counted.add(entry));
    if (!matches.length) { (draft && withheldFromDraft(check, entries) ? withheld : missing).push(check.context); continue; }
    const worst = matches.reduce((a, b) => rank[b.outcome] > rank[a.outcome] ? b : a).outcome;
    if (worst === "fail") failing.push(check.context);
    else if (worst === "pending") pending.push(check.context);
  }
  const verdict: CiResult = failing.length ? { state: "red", detail: `required failing: ${listOf(failing)}` }
    : pending.length || missing.length ? { state: "pending", detail: [pending.length ? `required waiting on: ${listOf(pending)}` : "", missing.length ? `required not reported yet: ${listOf(missing)}` : ""].filter(Boolean).join("; ") }
    : { state: "green", detail: `${required.length - withheld.length} required check(s) pass` };
  if (withheld.length) verdict.detail += `; withheld from drafts, required once ready: ${listOf(withheld)} (its workflow finished without posting it)`;
  if (verdict.state === "green") verdict.detail += notRequired(entries.filter((entry) => !counted.has(entry)));
  return verdict;
}

export function ciOf(home: string, identity: ProofIdentity, run: Run, now: Date): CiResult {
  try {
    const pr = readPullRequest(identity, run);
    let required = requiredChecks(home, identity.repository, pr.base, run, now);
    const stacked = !required.length && pr.defaultBranch !== undefined && pr.defaultBranch !== pr.base;
    if (stacked) required = requiredChecks(home, identity.repository, pr.defaultBranch!, run, now);
    const entries = entriesOf(identity, run);
    if (!required.length) return everyCheck(entries, identity.commit);
    const verdict = requiredVerdict(entries, required, pr.draft);
    return stacked ? { ...verdict, detail: `${verdict.detail} (required by ${pr.defaultBranch}; the base ${pr.base} requires none)` } : verdict;
  } catch (error) {
    return { state: "unknown", detail: (error as Error).message };
  }
}
