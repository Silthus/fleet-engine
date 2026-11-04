import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { askGap, authorOf, finishReview, listStanding, parseVerdict, proofDirectory, proofGate, readJson, recordGap, recordStanding, requireNone, requireProofs, respondToReview, reuseProof, reviewDirectory, reviewRecords, roundId, saveProof, startReview, storeCapturedFindings, unfinishedFleetReview, type Arbiter, type CiResult, type CleanBaseMerge, type ProofIdentity, type PushedHead } from "./proof.ts";
import { askModel, family, familyOf, readRubric, reviewerRow, sessionFamily, skillReferences, type Family } from "./proof-models.ts";
import { reviewPrompt } from "./proof-review.ts";
import { anchorCheck } from "./finding-anchors.ts";
import { reviewRules } from "./review-rules.ts";
import { listenIn, withoutThread, type ThreadWords } from "./proof-answers.ts";
import { modelFor } from "../../base/lib/models.ts";
import { numberSetting } from "../../base/lib/settings.ts";

export type ProofContext = { home: string; cwd: string; env: Record<string, string | undefined>; print: (text: string) => void; now?: () => Date; threadWords?: ThreadWords };
type Result = { code: number; stdout: string; stderr: string };
type Run = (command: string[]) => Result;
type Parsed = { options: Map<string, string>; flags: Set<string>; files: string[] };
type CommandContext = ProofContext & { run: Run };
type Subcommand = {
  usage: string; summary: string; examples: string[]; options?: string[]; flags?: string[];
  run: (parsed: Parsed, identity: () => ProofIdentity, context: CommandContext) => Promise<number>;
};

const answerHelp = `--thread names the T3 thread where the user gave the answer; a conductor may pass its own thread id. fleet
reads that thread, and the quoted words must be the user's whole answer to the question tool in the T3 app, given to
the question that fleet printed for this PR. A message they typed, or an answer sent through MCP, does not count. The
ledger keeps the thread, the message, the user's words, and the question they answered. Each answer counts once.`;

const overrideHelp = `--override takes the user's answer to the question that review-start prints when the arbiter escalates, gives no
verdict, or the ceiling stops the loop. Ask it with your question tool, with the options "Run one more round" and "Stop
here". Only their choice of "Run one more round" there counts, quoted with the date they gave it, for example
--override '2026-10-24 "Run one more round"' --thread <T3 thread id>. A typed message, a refusal, or a general rule,
such as "ship everything autonomously", does not answer a round. The question names the PR, and an answer to the
question of another PR does not count. One answer starts one round.
${answerHelp}
--standing takes your own reason for a round that the arbiter escalates or the ceiling refuses, when the user's
standing review rule (fleet proof standing --kind review) lets agents decide them. The round keeps the reason, the
rule, and the arbiter's verdict.
The settings pull-requests.freeReviews and pull-requests.reviewCeiling set how many rounds, and how many final reads
per phase, run before the arbiter weighs one more and where the loop stops. The arbiter is the lookup model of your
AI plan; FLEET_REVIEW_ARBITER replaces its command.`;

const subcommands: Record<string, Subcommand> = {
  path: {
    usage: "path", summary: "Print the proof directory of the commit.", examples: ["fleet proof path"],
    run: async (_, identity, { print, home }) => { print(proofDirectory(home, identity())); return 0; },
  },
  save: {
    usage: "save [--kind <kind>] <file>... | save --kind <kind> --reuse-from <sha> --reason <why>",
    summary: `Save evidence files for the commit. With --kind, the files prove that owed kind. Evidence counts for HEAD
and for clean merges of the base on top of it. When the evidence of an earlier commit still proves HEAD, record
that with --reuse-from and the reason; the gate prints it.`,
    examples: ["fleet proof save --kind live-run run.log", "fleet proof save --kind live-run --reuse-from 1a2b3c4 --reason 'The fix only renames a variable'"],
    options: ["--kind", "--reuse-from", "--reason"],
    run: async ({ options, files }, identity, { print, home, cwd, run }) => {
      if (options.has("--reuse-from")) {
        if (files.length) throw usageError("save", "Pass files or --reuse-from, not both");
        const from = resolveCommit(options.get("--reuse-from")!, run);
        print(JSON.stringify(await reuseProof(home, identity(), required(options, "--kind", "save"), from, required(options, "--reason", "save"))));
        return 0;
      }
      requireFiles(files, "save");
      for (const file of files) print(await saveProof(home, identity(), resolve(cwd, file), options.get("--kind")));
      return 0;
    },
  },
  require: {
    usage: "require (--kinds <kind,kind> | --none --reason <why>) [--author claude|gpt]",
    summary: `Record the proof kinds the PR owes. Repeated calls add kinds. A PR that owes none records --none with the
reason. The gate fails until one of them is recorded. The first call also records the model family that wrote the
PR, from the Claude Code or Codex session that runs it; pass --author only outside such a session. The recorded
family does not change.`,
    examples: ["fleet proof require --kinds live-run,ui-walk", "fleet proof require --none --reason 'Docs only'"],
    options: ["--kinds", "--reason", "--author"], flags: ["--none"],
    run: async ({ options, flags }, identity, { print, home, env }) => {
      if (flags.has("--none") === options.has("--kinds")) throw usageError("require", "Pass either --kinds or --none");
      const author = resolveAuthor(options.get("--author"), env);
      if (flags.has("--none")) { print(`none: ${(await requireNone(home, identity(), required(options, "--reason", "require"), author)).none!.reason}`); return 0; }
      const kinds = required(options, "--kinds", "require").split(",").map((value) => value.trim());
      print((await requireProofs(home, identity(), kinds, author)).join(","));
      return 0;
    },
  },
  review: {
    usage: "review [--scope full|fixes|final] [--base <reviewed-sha>] [--phase review|babysit] [--override <dated quote> --thread <id> | --standing <reason>]",
    summary: `Reserve a review round and run the reviewer yourself, read-only, from the model table of your AI plan: the review
row for a PR that Claude wrote, and the review-codex row for a PR that Codex wrote when the table has one, else the
review row. On the both plan that reviewer is the family that did not write the PR; on a single plan it is a fresh
session of that provider. fleet builds the prompt from the diff, the PR title and description, and the coding
standards in ~/.agents/guides/coding-standards.md, and saves the reviewer's answer as the findings, with an anchor
check of each finding against the diff. Answer them with fleet proof respond. Scope and --base work as for
review-start. When the reviewer gives no answer, the round stays reserved and the next fleet proof review on the same
commit retries it. The setting pull-requests.reviewTimeoutMinutes limits the reviewer. FLEET_PROOF_REVIEWER replaces
its command, and FLEET_PROOF_REVIEWER_MODEL its model.
${overrideHelp}`,
    examples: ["fleet proof review", "fleet proof review --scope fixes --base 1a2b3c4"],
    options: ["--scope", "--base", "--phase", "--override", "--thread", "--standing"],
    run: async ({ options }, identity, context) => runReview(options, identity(), context),
  },
  show: {
    usage: "show [--round <number|final|final-n>]",
    summary: "Print the latest review round, or --round: who reviewed it and where its findings are. --round final is the latest final read.",
    examples: ["fleet proof show", "fleet proof show --round 2", "fleet proof show --round final-1"],
    options: ["--round"],
    run: async ({ options }, identity, context) => {
      const directory = await reviewDirectory(context.home, identity(), roundOption(options));
      for (const line of await roundLines(directory)) context.print(line);
      return 0;
    },
  },
  respond: {
    usage: "respond --round <number|final-n> <responses.md>",
    summary: `Save your answer to each finding of a finished review: fixed in which commit, or rejected and why. Number the
answers in the order of the findings, one line each, such as "1. fixed in 1a2b3c4: <how>" or "2. rejected: <why>". Each
list item of findings.md is one finding; findings without a list are one. The gate fails while a finding has no
answer. A new call replaces the earlier answer. A final read takes the id that review-start printed.`,
    examples: ["fleet proof respond --round 1 responses.md", "fleet proof respond --round final-1 responses.md"],
    options: ["--round"],
    run: async ({ options, files }, identity, { print, home, cwd }) => {
      if (files.length !== 1) throw usageError("respond", "Pass one responses file");
      print(await respondToReview(home, identity(), roundId(required(options, "--round", "respond")), resolve(cwd, files[0]!)));
      return 0;
    },
  },
  standing: {
    usage: "standing [--kind <kind,kind> --until <date> --rule <rule>]",
    summary: `Record a standing rule: the user's rule in ~/.agents/guides/standing-rules.md that decides for them until a
date. For a gap kind, it accepts every gap of that kind; a judge gap still covers only its commit. Kind review lets
agents decide the review rounds that the arbiter escalates or the ceiling refuses. The user's instructions,
~/.agents/AGENTS.md or a file in ~/.agents/guides, must hold the whole command word for word, so only the user sets
the rule, its kinds, and its date. The rule lapses on the date or when it leaves their instructions. Without options,
list the standing rules.`,
    examples: ["fleet proof standing --kind prod-shape --until 2026-11-02 --rule '<the rule, word for word>'", "fleet proof standing --kind review,judge,post-deploy-watch --until 2026-11-26 --rule '<the rule, word for word>'", "fleet proof standing"],
    options: ["--kind", "--until", "--rule"],
    run: async ({ options }, _, { print, home }) => {
      if (!options.size) { for (const standing of await listStanding(home)) print(JSON.stringify(standing)); return 0; }
      for (const standing of await recordStanding(home, required(options, "--kind", "standing"), required(options, "--until", "standing"), required(options, "--rule", "standing"))) print(JSON.stringify(standing));
      return 0;
    },
  },
  gap: {
    usage: "gap --kind <kind> (--reason <why it could not run> | --accept <the user's words> --thread <id>)",
    summary: `Record why an owed proof could not run, or the user's acceptance of that gap. --reason prints a question
that names the gap kind and the PR, with the options "Accept the gap" and "Keep the gap open". Ask it with your
question tool. --accept takes their choice of "Accept the gap" there, with their words in quotes. A typed message, a
refusal, an answer to another question, a quote of the user's instructions, or an answer already recorded elsewhere
does not count. A standing rule (fleet proof standing) covers a kind without asking. Their acceptance settles the
kind: the gate then ignores that kind's evidence. Kind ci records that CI cannot run on HEAD, such as on a fork PR.
${answerHelp}`,
    examples: ["fleet proof gap --kind prod-shape --reason 'No production read access'", `fleet proof gap --kind prod-shape --accept '2026-10-25 "Accept the gap"' --thread mcp:1a2b`],
    options: ["--kind", "--reason", "--accept", "--thread"],
    run: async ({ options }, identity, context) => {
      const kind = required(options, "--kind", "gap");
      const [reason, accept] = [options.get("--reason"), options.get("--accept")];
      if ((reason === undefined) === (accept === undefined)) throw usageError("gap", "Pass either --reason or --accept");
      const update = reason === undefined ? { accept: accept!, hear: hearing(options, context) } : { reason };
      const gap = await recordGap(context.home, identity(), kind, update);
      context.print(JSON.stringify(gap));
      if (reason !== undefined) context.print(askGap(identity(), kind, reason));
      return 0;
    },
  },
  gate: {
    usage: "gate [--landed]",
    summary: `Check the owed proofs, the review and the answers to its findings, and the CI of the commit on GitHub. Exit 0
only on a pass: 1 means the owed proofs are not recorded, a proof is missing, the commit is not reviewed, a finding
has no answer, the commit is not the PR's head on GitHub, or its checks are red or pending; 3 means only unaccepted
gaps remain. No gap waives the head check. The last line is the verdict and names what it covered. A clean merge of
the PR's base carries the review and the evidence of its other parent forward.`,
    examples: ["fleet proof gate", "fleet proof gate --landed"], flags: ["--landed"],
    run: async ({ flags }, identity, { print, home, run, now }) => {
      const head = identity();
      const gate = await proofGate(home, head, { landed: flags.has("--landed"), cleanBaseMerge: cleanBaseMerge(head, run), ci: () => ciOf(head, run), pushedHead: () => pushedHeadOf(head, run), now: now?.() });
      for (const line of gate.lines) print(line);
      print(gate.code === 0 ? `gate: pass (${gate.summary})` : `gate: fail (exit ${gate.code})`);
      return gate.code;
    },
  },
  "review-start": {
    usage: "review-start [--scope full|fixes|final] [--base <reviewed-sha>] [--phase review|babysit] [--override <dated quote> --thread <id> | --standing <reason>]",
    summary: `Reserve a review round before you dispatch its reviewers. Round 1 is --scope full and takes no --base. A later
round is --scope fixes, and a final read is --scope final; both take --base with the commit of the latest finished
review. The printed id names the round for review-finish and respond.
A later round with the user's --override, or --standing under their standing rule, may be --scope full: it reviews
the whole PR diff at HEAD again, such as after a restack.
${overrideHelp}`,
    examples: ["fleet proof review-start --scope full", "fleet proof review-start --scope fixes --base 1a2b3c4", "fleet proof review-start --scope final --base 1a2b3c4"],
    options: ["--scope", "--base", "--phase", "--override", "--thread", "--standing"],
    run: async ({ options }, identity, context) => {
      const head = identity();
      const base = options.has("--base") ? resolveCommit(options.get("--base")!, context.run) : undefined;
      context.print(JSON.stringify(await startReview(context.home, head, { scope: options.get("--scope") ?? "full", base, ...decisionOf(options, context), phase: options.get("--phase"), cleanBaseMerge: cleanBaseMerge(head, context.run) })));
      return 0;
    },
  },
  "review-finish": {
    usage: "review-finish --round <number|final-n> --reviewer <model> <findings.md>",
    summary: `Save the findings of a reserved round after its reviewers finish. --round takes the id that review-start
printed. --reviewer names the model that wrote them; the gate prints it. The findings file must not be empty; write
"No findings." when the reviewer found none.`,
    examples: ["fleet proof review-finish --round 1 --reviewer gpt-6.1-sol findings.md", "fleet proof review-finish --round final-1 --reviewer claude-opus-5-5 findings.md"],
    options: ["--round", "--findings", "--reviewer"],
    run: async ({ options, files }, identity, { print, home, cwd }) => {
      const findings = options.has("--findings") ? [options.get("--findings")!, ...files] : files;
      if (findings.length !== 1) throw usageError("review-finish", "Pass one findings file");
      const round = roundId(required(options, "--round", "review-finish"));
      const reviewer = required(options, "--reviewer", "review-finish");
      print(await finishReview(home, identity(), round, resolve(cwd, findings[0]!), reviewer));
      return 0;
    },
  },
};

async function runReview(options: Map<string, string>, head: ProofIdentity, context: CommandContext) {
  const { print, home, cwd, env, run } = context;
  const author = await authorOf(home, head);
  const row = reviewerRow(author, env);
  const limit = numberSetting("pull-requests.reviewTimeoutMinutes", env) * 60_000;
  const rubric = await readRubric(home);
  const pending = await unfinishedFleetReview(home, head);
  const reserved = pending
    ? { round: pending.reservation.round, id: basename(pending.directory), directory: pending.directory, scope: pending.reservation.scope, base: pending.reservation.base }
    : await reserveFleetReview(options, head, context);
  const from = reserved.scope === "full" ? mergeBase(head, run) : reserved.base!;
  const pr = pullRequestDetails(head, run);
  const rules = reviewRules(changedFilesOf(from, head.commit, run), baseTip(head, run), run);
  const diff = diffOf(from, head.commit, run);
  const diffFile = join(reserved.directory, "diff.patch");
  await writeFile(diffFile, diff, { mode: 0o600 });
  const prompt = reviewPrompt({ scope: reserved.scope, from, commit: head.commit, diff, diffFile, crossFamily: familyOf(row) !== author, title: pr.title, body: pr.body, rubric, references: skillReferences(home), reviewRules: rules });
  const answer = await askModel("reviewer", row, { prompt, cwd: topLevel(run) ?? cwd, readable: [join(home, ".agents/skills"), reserved.directory] }, env, limit);
  const label = reserved.round === "final" ? "The final read" : `Round ${reserved.round}`;
  if (!answer.ok) throw new Error(`The reviewer ${answer.model} gave no findings (${answer.cause}). ${label} stays reserved; run fleet proof review again to retry it`);
  const findings = [answer.text.trim(), anchorCheck(answer.text, diff, await reviewRecords(home, head))].filter(Boolean).join("\n\n");
  await storeCapturedFindings(reserved.directory, head, roundId(reserved.id), findings, answer.model);
  print(JSON.stringify({ round: reserved.round, id: reserved.id, directory: reserved.directory, reviewer: answer.model }));
  print(findings);
  return 0;
}

async function reserveFleetReview(options: Map<string, string>, head: ProofIdentity, context: CommandContext) {
  const scope = options.get("--scope") ?? "full";
  if (["fixes", "final"].includes(scope) && !options.has("--base")) throw usageError("review", "--scope fixes and --scope final need --base with the commit of the latest finished review");
  const base = options.has("--base") ? resolveCommit(options.get("--base")!, context.run) : undefined;
  const reserved = await startReview(context.home, head, { scope, base, ...decisionOf(options, context), phase: options.get("--phase"), cleanBaseMerge: cleanBaseMerge(head, context.run), capturedBy: "fleet" });
  return { ...reserved, scope, base };
}

async function roundLines(directory: string) {
  const round = await readJson<{ round: number | "final"; commit: string; reviewer?: string; capturedBy?: string; standing?: { reason: string; until: string } } | undefined>(join(directory, "round.json"), undefined);
  if (!round) throw new Error(`${directory} has no reservation`);
  const finished = round.reviewer ? `finished by ${round.reviewer}, ${round.capturedBy === "fleet" ? "captured by fleet" : "saved by the author"}: ${join(directory, "findings.md")}` : "reserved, no findings yet";
  const header = `${round.round === "final" ? "final read" : `round ${round.round}`} on ${short(round.commit)}: ${finished}`;
  return [header, ...(round.standing ? [`accepted by the standing rule until ${round.standing.until}: ${round.standing.reason}`] : [])];
}

function roundOption(options: Map<string, string>) {
  const round = options.get("--round");
  return round === undefined ? undefined : round === "final" ? "final" : roundId(round);
}

const arbiterLimit = 180_000;

const arbiterOf = ({ env, cwd }: CommandContext): Arbiter => async (prompt) => {
  const answer = await askModel("arbiter", modelFor("lookup", env), { prompt, cwd }, env, arbiterLimit);
  return answer.ok ? parseVerdict(answer.text, answer.model) : { verdict: "unavailable", reason: answer.cause, model: answer.model };
};

const decisionOf = (options: Map<string, string>, context: CommandContext) => ({
  override: options.get("--override"), standing: options.get("--standing"), hear: hearing(options, context), arbiter: arbiterOf(context), now: context.now?.(),
  limits: { free: numberSetting("pull-requests.freeReviews", context.env), ceiling: numberSetting("pull-requests.reviewCeiling", context.env) },
});

function hearing(options: Map<string, string>, { threadWords }: CommandContext) {
  const thread = options.get("--thread");
  return thread === undefined ? withoutThread : listenIn(thread, threadWords ?? unreadableThreads);
}

const unreadableThreads: ThreadWords = async (thread) => {
  throw new Error(`Cannot read T3 thread ${thread}: this version of fleet proof does not read T3 threads yet`);
};

function resolveAuthor(requested: string | undefined, env: Record<string, string | undefined>): Family | undefined {
  const session = sessionFamily(env);
  const author = requested === undefined ? undefined : family(requested);
  if (author && session && author !== session) throw new Error(`--author ${author} contradicts the session: this session is ${session}`);
  return author ?? session;
}

const identityHelp = `Every command works on the PR of the current branch and its HEAD. Pass --repo owner/name, --pr number,
or --commit to choose others. --commit and --base take any commit Git resolves here, such as a short SHA.`;
const kindsHelp = "Kinds: live-run, ui-walk, prod-shape, cross-version, shadow-diff, post-deploy-watch. A gap also takes ci and judge, and a standing rule also takes review.";

function overview() {
  const lines = Object.values(subcommands).map((command) => `  fleet proof ${command.usage}`);
  return [`Usage: fleet proof <command> [--repo owner/name] [--pr number] [--commit sha]`, ...lines, "", identityHelp, kindsHelp,
    "Run fleet proof <command> --help for its details and an example."].join("\n");
}

function help(name: string, command: Subcommand) {
  return [`Usage: fleet proof ${command.usage} [--repo owner/name] [--pr number] [--commit sha]`, "", command.summary, "", identityHelp,
    ...(["save", "require", "gap", "standing"].includes(name) ? [kindsHelp] : []), "", "Examples:", ...command.examples.map((example) => `  ${example}`)].join("\n");
}

const usageError = (name: string, problem: string) => new Error(`${problem}. Run fleet proof ${name} --help.`);

function required(options: Map<string, string>, option: string, name: string) {
  const value = options.get(option);
  if (value === undefined) throw usageError(name, `${option} is required`);
  return value;
}

function requireFiles(files: string[], name: string) {
  if (!files.length) throw usageError(name, "Pass at least one file");
}

function parse(name: string, command: Subcommand, args: string[]): Parsed {
  const valued = ["--repo", "--pr", "--commit", ...(command.options ?? [])];
  const parsed: Parsed = { options: new Map(), flags: new Set(), files: [] };
  while (args.length) {
    const arg = args.shift()!;
    if (command.flags?.includes(arg)) parsed.flags.add(arg);
    else if (valued.includes(arg)) {
      const value = args.shift();
      if (value === undefined || value.startsWith("--")) throw usageError(name, `${arg} needs a value`);
      parsed.options.set(arg, value);
    } else if (arg.startsWith("-")) throw usageError(name, `Unknown option ${arg}`);
    else parsed.files.push(arg);
  }
  return parsed;
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

function resolveCommit(revision: string, run: Run) {
  if (/^[0-9a-f]{40}$/.test(revision)) return revision;
  const resolved = run(["git", "rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  if (resolved.code !== 0) throw new Error(`Cannot resolve commit ${revision} here. Run in the PR checkout or pass the full SHA`);
  return resolved.stdout.trim();
}

function resolvePullRequest(repository: string | undefined, pr: string | undefined, run: Run) {
  if (repository !== undefined && pr !== undefined) return { repository, pr: Number(pr) };
  const branch = pr ?? (repository ? firstLine(run(["git", "branch", "--show-current"]).stdout) : "");
  const view = run(["gh", "pr", "view", ...(branch ? [branch] : []), ...(repository ? ["--repo", repository] : []), "--json", "number,url"]);
  const found = view.code === 0 ? JSON.parse(view.stdout) as { number?: number; url?: string } : {};
  const url = /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(found.url ?? "");
  if (!url || !found.number) throw new Error(`Cannot find the PR of this checkout with gh (${firstLine(view.stderr) || "no PR"}). Pass --repo owner/name --pr number`);
  return { repository: url[1]!, pr: found.number };
}

function resolveIdentity(options: Map<string, string>, run: Run): ProofIdentity {
  const commit = resolveCommit(options.get("--commit") ?? "HEAD", run);
  return { ...resolvePullRequest(options.get("--repo"), options.get("--pr"), run), commit };
}

function topLevel(run: Run) {
  const result = run(["git", "rev-parse", "--show-toplevel"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

function mergeBase(identity: ProofIdentity, run: Run) {
  for (const ref of baseRefs(identity, run)) {
    const result = run(["git", "merge-base", ref, identity.commit]);
    if (result.code === 0) return result.stdout.trim();
  }
  throw new Error(`Cannot find where ${identity.repository}#${identity.pr} branched from its base here. Fetch the base branch from a remote of ${identity.repository}`);
}

function baseTip(identity: ProofIdentity, run: Run) {
  for (const ref of baseRefs(identity, run)) {
    const result = run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (result.code === 0) return result.stdout.trim();
  }
  throw new Error(`Cannot find the base branch of ${identity.repository}#${identity.pr} here. Fetch it from a remote of ${identity.repository}`);
}

function changedFilesOf(from: string, to: string, run: Run) {
  return run(["git", "diff", "--name-only", "--no-relative", from, to]).stdout.split("\n").filter(Boolean);
}

function diffOf(from: string, to: string, run: Run) {
  const diff = run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-relative", from, to]);
  if (diff.code !== 0) throw new Error(`Cannot diff ${short(from)}..${short(to)} here (${firstLine(diff.stderr)})`);
  return diff.stdout;
}

function pullRequestDetails(identity: ProofIdentity, run: Run) {
  const view = run(["gh", "pr", "view", String(identity.pr), "--repo", identity.repository, "--json", "title,body,baseRefName"]);
  if (view.code !== 0) throw new Error(`Cannot read ${identity.repository}#${identity.pr} with gh (${firstLine(view.stderr)})`);
  const { title = "", body = "", baseRefName = "" } = JSON.parse(view.stdout) as { title?: string; body?: string; baseRefName?: string };
  return { title, body, baseRefName };
}

function baseRefs(identity: ProofIdentity, run: Run) {
  const view = run(["gh", "pr", "view", String(identity.pr), "--repo", identity.repository, "--json", "baseRefName"]);
  if (view.code !== 0) throw new Error(`Cannot read the base branch of ${identity.repository}#${identity.pr} with gh (${firstLine(view.stderr)})`);
  const base = (JSON.parse(view.stdout) as { baseRefName: string }).baseRefName;
  return remotesOf(identity.repository, run).map((remote) => `refs/remotes/${remote}/${base}`);
}

function remotesOf(repository: string, run: Run) {
  const remotes = run(["git", "remote"]).stdout.split("\n").filter(Boolean);
  return remotes.filter((remote) => new RegExp(`github\\.com[:/]${repository.replace(/\./g, "\\.")}(\\.git)?/?$`, "i").test(run(["git", "remote", "get-url", remote]).stdout.trim()));
}

function cleanBaseMerge(identity: ProofIdentity, run: Run): CleanBaseMerge {
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

function pushedHeadOf(identity: ProofIdentity, run: Run): PushedHead {
  const view = run(["gh", "pr", "view", String(identity.pr), "--repo", identity.repository, "--json", "headRefOid"]);
  if (view.code !== 0) return { error: `gh failed: ${firstLine(view.stderr)}` };
  return { commit: (JSON.parse(view.stdout) as { headRefOid?: string }).headRefOid ?? "" };
}

type Check = { name: string; bucket: "pass" | "fail" | "pending" };
type CheckRun = { name: string; status: string; conclusion: string | null };
type CommitStatus = { context: string; state: string };
const passing = ["success", "neutral", "skipped"];

function commitRecords<T>(identity: ProofIdentity, run: Run, path: string, jq: string): T[] | string {
  const result = run(["gh", "api", "--paginate", `repos/${identity.repository}/commits/${identity.commit}/${path}?per_page=100`, "--jq", jq]);
  if (result.code !== 0) return `gh api ${path} failed (${firstLine(result.stderr)})`;
  try { return result.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T); }
  catch { return `gh api ${path} printed no JSON lines`; }
}

function checksOf(identity: ProofIdentity, run: Run): Check[] | string {
  const runs = commitRecords<CheckRun>(identity, run, "check-runs", ".check_runs[] | {name, status, conclusion}");
  const statuses = commitRecords<CommitStatus>(identity, run, "statuses", ".[] | {context, state}");
  if (typeof runs === "string") return runs;
  if (typeof statuses === "string") return statuses;
  const latest = statuses.filter((status, index) => statuses.findIndex((other) => other.context === status.context) === index);
  return [
    ...runs.map((check): Check => ({ name: check.name, bucket: check.status !== "completed" ? "pending" : passing.includes(check.conclusion ?? "") ? "pass" : "fail" })),
    ...latest.map((status): Check => ({ name: status.context, bucket: status.state === "success" ? "pass" : status.state === "pending" ? "pending" : "fail" })),
  ];
}

function ciOf(identity: ProofIdentity, run: Run): CiResult {
  const checks = checksOf(identity, run);
  if (typeof checks === "string") return { state: "unknown", detail: checks };
  if (!checks.length) return { state: "none", detail: `no checks reported on ${short(identity.commit)}` };
  const named = (bucket: Check["bucket"]) => checks.filter((check) => check.bucket === bucket).map((check) => check.name);
  const [failing, pending] = [named("fail"), named("pending")];
  if (failing.length) return { state: "red", detail: `failing: ${failing.join(", ")}` };
  if (pending.length) return { state: "pending", detail: `waiting on: ${pending.join(", ")}` };
  return { state: "green", detail: `${checks.length} check(s) on ${short(identity.commit)}` };
}

const short = (commit: string) => commit.slice(0, 7);

const runIn = (cwd: string, env: Record<string, string | undefined>): Run => (command) => {
  try {
    const child = Bun.spawnSync(command, { cwd, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode ?? 1, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  } catch (error) {
    return { code: 127, stdout: "", stderr: `${command[0]}: ${(error as Error).message}` };
  }
};

export async function proofCommand(args: string[], context: ProofContext): Promise<number> {
  const name = args.shift();
  if (name === undefined || ["help", "--help", "-h"].includes(name)) {
    if (name === undefined) throw new Error("Name a command. Run fleet proof --help");
    context.print(overview());
    return 0;
  }
  const command = subcommands[name];
  if (!command) throw new Error(`Unknown command ${name}. Run fleet proof --help`);
  if (args.includes("--help") || args.includes("-h")) { context.print(help(name, command)); return 0; }
  const run = runIn(context.cwd, context.env);
  const parsed = parse(name, command, args);
  let identity: ProofIdentity | undefined;
  return command.run(parsed, () => identity ??= resolveIdentity(parsed.options, run), { ...context, run });
}
