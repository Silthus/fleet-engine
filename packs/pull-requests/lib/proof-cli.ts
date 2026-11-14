import { closeSync, existsSync, openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { askGap, authorOf, finishReview, startGateRun, ledgerRoot, listStanding, proofDirectory, readJson, readOwed, recordGap, recordGapCommand, recordStanding, requireChoice, requireNone, requireProofs, requireReservation, respondToReview, reuseProof, reviewDirectory, reviewOfCommit, reviewRecords, roundId, roundQuestion, runOption, saveProof, startReview, stopOption, storeCapturedFindings, unfinishedReview, writeJson, markRecorded, readReservation, recordReceipt, roundDirectories, unrecordedElsewhere, type Arbiter, type Reservation, type CapturedBy, type ProofIdentity } from "./proof.ts";
import { AnswerTaken, appendOnce, decideAlone, hearUser, ledgerHolds, ledgerOf } from "./decision-cli.ts";
import { HubUnreachable, refText, type Decision, type Ssh } from "./decision-ledger.ts";
import { readComment, runIn } from "./pr-ci.ts";
import { askModel, family, familyOf, isQuotaExhausted, modelLabel, quotaExitCode, readRubric, reviewerRow, sessionFamily, skillReferences, type Family } from "./proof-models.ts";
import { runProof, type RunIO } from "./proof-run.ts";
import { lensBrief, lensIdle, lensLog, panelGuideText, panelLines, publishPanel, readPanelGuide, readPlan, recordWorker, requeueFailed, resolveLens, runLens, stagedPlan, stagePanel, waitForPanel, withRoundLock, withSlot, lockNewRound, processStart, roundLock, RoundBusy, RoundGone, type Lens, type LockOwner, type PanelGuide, type PanelIO, type Plan, type RoundLock, type StartTime } from "./proof-panel.ts";
import { evalsPath, promptTemplateHash, readRuns, reportLines, saveRun, scoreCases, type EvalIO } from "./proof-eval.ts";
import { hashOf, missesPath, missSource, missSources, readMisses, recordMiss } from "./proof-misses.ts";
import { githubRequest, publishProof, type GitHub } from "./proof-publish.ts";
import { displayLine, recordCaption, recordLines } from "./proof-display.ts";
import { reviewPrompt } from "./proof-review.ts";
import { leftOutNote, reviewRange } from "./proof-range.ts";
import { quietCommitIn } from "./proof-delta.ts";
import { baseTip, cleanBaseMerge, mergeBase, pullRequestDetails, remotesOf, topLevel } from "./proof-checkout.ts";
import { arbiterOf, finalGate, reviewLimit, type FinalGate } from "./proof-gate.ts";
import { anchorCheck } from "./finding-anchors.ts";
import { reviewRules } from "./review-rules.ts";
import type { ThreadWords } from "./proof-answers.ts";
import { modelFor } from "../../base/lib/models.ts";
import { numberSetting } from "../../base/lib/settings.ts";

export type { RunIO };

export type ProofContext = {
  home: string; cwd: string; env: Record<string, string | undefined>; print: (text: string) => void; now?: () => Date; threadWords?: ThreadWords;
  detach?: (args: string[], log: string) => Promise<number>; pause?: () => Promise<void>; github?: GitHub; runIO?: RunIO;
  ssh?: Ssh; pid?: number; startTime?: StartTime;
};
type Result = { code: number; stdout: string; stderr: string };
type Run = (command: string[]) => Result;
type Parsed = { options: Map<string, string>; lists: Map<string, string[]>; flags: Set<string>; files: string[]; command?: string[] };
type CommandContext = ProofContext & { run: Run; lock: () => Promise<RoundLock> };
type Subcommand = {
  usage: string; summary: string; examples: string[]; options?: string[]; repeatable?: string[]; flags?: string[]; hidden?: boolean; takesCommand?: boolean;
  run: (parsed: Parsed, identity: () => ProofIdentity, context: CommandContext) => Promise<number>;
};

const overrideHelp = `--override takes the user's answer to the question that review-start prints when the arbiter escalates, gives no
verdict, or the ceiling stops the loop. Ask it with your question tool, with the options "Run one more round" and "Stop
here". Only their choice of "Run one more round" there counts, quoted with the date they gave it, for example
--override '2026-10-24 "Run one more round"'. --thread names the T3 thread where they answered and defaults to this
one (T3CODE_THREAD_ID). A typed message, a refusal, or a general rule, such as "ship everything autonomously", does
not answer a round. The question names the PR, and an answer to the question of another PR does not count. The
answer lands in the decision ledger as a 👤 review decision; one answer records one decision and starts one round.
--agent takes your own reason for a round that the arbiter escalates or the ceiling refuses. It lands in the ledger
as a 🤖 review decision, refused on a PR whose merge-risk callout has no Tier line at HEAD. --standing is its old
name. The round keeps the decision and the arbiter's verdict. List decisions with fleet decision list.
A round starts only once its decision is in the ledger. A round that holds a decision stays reserved until the
ledger holds another decision for the same answer. A round of another commit whose decision is still not in the
ledger is dropped when the next round starts: its decision never counted. It stays reserved while the hub is down or
while another command works on it, and the next round starts anyway. When the hub fails or the command stops
before the decision is recorded, run the same command again: it records the same decision, appends it only when the
ledger does not hold it yet, asks for no new answer, and goes on with that round. A panel whose lenses never started
starts them on the same command or on --wait, with or without --round, and each lens starts once. A single-reviewer
round whose findings are saved prints them and runs no reviewer again. review-finish records the round's decision
first when its review-start ended before it did. Commands on one round take turns, and a new round is reserved with
its lock already held. A command that finds another fleet proof command at work on the round stops and names its
process and lock file; wait for it to end, then run the command again, or, on a panel, run fleet proof review --wait,
which waits for it. A round is taken over when its command is gone, when its process id now names a process that
started later, or when its lock file stays empty for a minute.
The settings pull-requests.freeReviews and pull-requests.reviewCeiling set how many rounds, and how many final reads
per phase, run before the arbiter weighs one more and where the loop stops. The arbiter is the lookup model of your
AI plan; FLEET_REVIEW_ARBITER replaces its command.`;

const subcommands: Record<string, Subcommand> = {
  path: {
    usage: "path", summary: "Print the proof directory of the commit.", examples: ["fleet proof path"],
    run: async (_, identity, { print, home }) => { print(proofDirectory(home, identity())); return 0; },
  },
  save: {
    usage: "save [--kind <kind> [--ran <what ran> --result <what it showed>]] <file>... | save --kind <kind> --ran <what ran> --result <what it showed> | save --kind ui-walk --caption <caption> <screenshot> | save --kind <kind> --reuse-from <sha> --reason <why>",
    summary: `Save evidence files for the commit. With --kind, the files prove that owed kind. Evidence counts for HEAD
and for clean merges of the base on top of it. When the evidence of an earlier commit still proves HEAD, record
that with --reuse-from and the reason; the gate prints it.
--ran and --result give one line each of what ran and what it showed, for the proof receipt. Without files they
record only the lines, such as for evidence that fleet proof run saved. A later save of the kind at the commit with
them replaces both, and a save without them keeps them. --caption names what one ui-walk screenshot shows; the
receipt lists screenshots in the order of their first caption, and a new caption keeps that place. The lines and
captions live in the PR's display/ directory, outside the evidence: the gate and the judge never read them.`,
    examples: [
      "fleet proof save --kind live-run --ran 'Sent a test email to the sandbox inbox' --result 'Delivered in one attempt' run.log",
      "fleet proof save --kind ui-walk --caption 'Settings page after the save' after.png",
      "fleet proof save --kind live-run --reuse-from 1a2b3c4 --reason 'The fix only renames a variable'",
    ],
    options: ["--kind", "--reuse-from", "--reason", "--ran", "--result", "--caption"],
    run: async ({ options, files }, identity, { print, home, cwd, run, now }) => {
      const kind = options.get("--kind");
      const lines = options.has("--ran") || options.has("--result");
      const caption = options.get("--caption");
      if (lines && !(options.has("--ran") && options.has("--result"))) throw usageError("save", "Pass --ran and --result together");
      if ((lines || caption !== undefined) && options.has("--reuse-from")) throw usageError("save", "A reused kind shows the lines of the commit it reuses. Drop --ran, --result, and --caption");
      if (lines && kind === undefined) throw usageError("save", "--ran and --result need --kind");
      if (caption !== undefined && kind !== "ui-walk") throw usageError("save", "--caption needs --kind ui-walk");
      if (caption !== undefined && files.length !== 1) throw usageError("save", "--caption names one screenshot. Save each screenshot with its own caption");
      if (options.has("--reuse-from")) {
        if (files.length) throw usageError("save", "Pass files or --reuse-from, not both");
        const from = resolveCommit(options.get("--reuse-from")!, run);
        print(JSON.stringify(await reuseProof(home, identity(), required(options, "--kind", "save"), from, required(options, "--reason", "save"))));
        return 0;
      }
      for (const option of ["--ran", "--result", "--caption"]) if (options.has(option)) displayLine(options.get(option)!, option);
      if (!lines) requireFiles(files, "save");
      const saved: string[] = [];
      for (const file of files) { saved.push(await saveProof(home, identity(), resolve(cwd, file), kind)); print(saved.at(-1)!); }
      if (lines) await recordLines(home, identity(), kind!, options.get("--ran")!, options.get("--result")!);
      if (caption !== undefined) await recordCaption(home, identity(), saved[0]!, caption, now?.() ?? new Date());
      return 0;
    },
  },
  run: {
    usage: "run --kind <kind> -- <command> [argument...]",
    summary: `Run a proof command on a clean commit and save its output as evidence of the kind. Everything after the first
-- is the command, unchanged, run without a shell and with stdin closed; run a pipeline as sh -c '<pipeline>'. The
output passes through to the terminal, and stdout and stderr go together into one private spool. fleet reads HEAD
and the status before and after the run: a tree with modified or untracked files refuses with exit 2, so commit
first. Only a run that exits 0 with text output, with HEAD unchanged and the tree clean at both checks, saves: the
output, with known secrets redacted, as <kind> evidence of the HEAD read before the run, and a run record of the
redacted command in runs/<commit>/<kind>/. Every other run saves nothing, says why, and exits with the command's
status: 128 + n when signal n stopped it, 127 when it cannot start, and 1 when it printed nothing, printed a null
byte, or HEAD or the tree changed. The judge marks runner files as captured by the Fleet runner. --commit is not
taken; ui-walk takes screenshots, so save them with fleet proof save.`,
    examples: ["fleet proof run --kind live-run -- bun test src/send.test.ts", "fleet proof run --kind live-run -- sh -c 'curl -s localhost:8000/health | jq .status'"],
    options: ["--kind"], takesCommand: true,
    run: async ({ options, command }, _, context) => {
      if (options.has("--commit")) throw usageError("run", "--commit is not taken: the runner reads HEAD from Git. After --, --commit belongs to the command");
      if (!command?.length) throw usageError("run", "Pass the command after --");
      const kind = required(options, "--kind", "run");
      const pr = resolvePullRequest(options.get("--repo"), options.get("--pr"), context.run);
      return runProof({ home: context.home, pr, kind, command, cwd: context.cwd, env: context.env, print: context.print, io: context.runIO });
    },
  },
  publish: {
    usage: "publish --asset-repo <owner/name> [--recheck] <file>...",
    summary: `Publish screenshots to a public repository of your own GitHub account when gh cannot attach them to the PR.
--asset-repo names that repository; fleet has no default. It refuses a private repository and one your account does
not own, and it publishes each screenshot under proof/ on the fleet-proof branch, named by the hash of its bytes,
with no name of the PR or its repository. Publish only screenshots with invented test data. --recheck asks GitHub
again after you change the repository's access.`,
    examples: ["fleet proof publish --asset-repo octocat/assets after.png"], options: ["--asset-repo"], flags: ["--recheck"],
    run: async ({ options, flags, files }, identity, { print, home, cwd, github }) => {
      requireFiles(files, "publish");
      const assets = required(options, "--asset-repo", "publish");
      for (const file of files) print(await publishProof(home, identity(), resolve(cwd, file), assets, github ?? githubRequest, flags.has("--recheck")));
      return 0;
    },
  },
  receipt: {
    usage: "receipt --comment <url>",
    summary: `Record the PR's proof receipt: the comment you posted on the PR with the gate's result. GitHub must show the
comment on this PR. fleet proof gate --json and fleet decision report link it.`,
    examples: ["fleet proof receipt --comment https://github.com/owner/name/pull/7#issuecomment-1"], options: ["--comment"],
    run: async ({ options }, identity, { home, print, run }) => {
      const url = required(options, "--comment", "receipt");
      const comment = readComment(url, run);
      const { repository, pr } = identity();
      if (`${comment.repository}#${comment.pr}`.toLowerCase() !== refText({ repository, pr }).toLowerCase()) throw new Error(`The comment ${url} is on ${comment.repository}#${comment.pr}, not on ${refText({ repository, pr })}`);
      await recordReceipt(home, { repository, pr }, url);
      print(`receipt: ${url}`);
      return 0;
    },
  },
  require: {
    usage: "require (--kinds <kind,kind> | --none --reason <why>) [--author claude|gpt]",
    summary: `Record the proof kinds the PR owes. Repeated calls add kinds. A PR that owes none records --none with the
reason. The gate fails until one of them is recorded. The first call also records the model family that wrote the
PR, from the Claude Code or Codex session that runs it; pass --author only outside such a session. fleet proof review
and the judge pick their model from it: the review row of the model table for a PR that Claude wrote, and the
review-codex row for one that Codex wrote when the table has one. The recorded family does not change.`,
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
    usage: "review [--lens <name>[:same|:other]]... [--knowledge <lens>=<file>]... [--scope full|fixes|final] [--base <reviewed-sha>] [--phase review|babysit] [--override <dated quote> [--thread <id>] | --agent <reason>] | review --wait [--round <number|final>]",
    summary: `Reserve a review round and run the reviewer yourself, read-only, from the model table of your AI plan: the review
row for a PR that Claude wrote, and the review-codex row for a PR that Codex wrote when the table has one, else the
review row. On the both plan that reviewer is the family that did not write the PR; on a single plan it is a fresh
session of that provider. fleet builds the prompt from the diff, the PR title and description, and the coding
standards in ~/.agents/guides/coding-standards.md, and saves the reviewer's answer as the findings. fleet checks each
finding's anchor against the diff and prints the result after the findings; it keeps it apart, in anchors.md. Answer them with fleet proof respond. Scope and --base work as for
review-start. When the reviewer gives no answer, the round stays reserved and the next fleet proof review on the same
commit retries it. The setting pull-requests.reviewTimeoutMinutes limits the reviewer. FLEET_PROOF_REVIEWER replaces
its command, and FLEET_PROOF_REVIEWER_MODEL its model.
Spent quota stops a reviewer or judge early. When its CLI prints two quota lines in a row, such as
"Reconnecting... 1/5" and "Reconnecting... 2/5", "exceeded retry limit, last status: 429", or "All credentials for
model <model> are cooling down", and then prints nothing else for 5 minutes, fleet stops it. A run that fails right
after one such line counts too. The cause starts with "quota exhausted", and fleet proof review exits 4.
FLEET_PROOF_QUOTA_GRACE_MS changes the 5 minutes; 0 stops the run at once.

With --lens, the round is a qa-swarm panel: one reviewer per lens, each with the Brief of the qa-swarm PANEL.md in
~/.agents/skills/qa-swarm, filled by fleet, and the lens's hunting grounds. A lens runs on the family of its PANEL.md
lane: the fresh-eyes lane on the author's family, the others on the reviewer above. :same or :other picks the family.
--knowledge adds the repo's review material for a lens, and gives the text of a Team perspective that PANEL.md does
not list. fleet starts the lenses in the background and returns at once; at most pull-requests.panelSlots reviewers
run at once on this machine, and the rest wait. Each raw answer is kept in lenses/<name>.md. A lens that ends without
a FINDINGS block or a COVERED list of every changed file runs once more, and a lens stopped by spent quota does not;
when it fails again, the round stays unfinished with the cause, and the same review --lens command reruns the failed
lenses; :same or :other moves a failed lens to the family that is up when the other has an outage. When every lens
is done, fleet joins the answers under one heading per lens as the round's findings.
--wait waits up to 9 minutes for the panel of the unfinished round, the latest round, or --round, and prints each
lens. Exit 0 when the round is finished, with its findings; 1 when a lens failed; 2 when lenses still run, so run
--wait again; 4 when a lens stopped on spent quota. It restarts a lens whose worker died, and waits while another
fleet proof command works on the round.
${overrideHelp}`,
    examples: ["fleet proof review", "fleet proof review --scope fixes --base 1a2b3c4", "fleet proof review --lens fresh-eyes --lens correctness --lens design --knowledge correctness=incidents.md", "fleet proof review --wait"],
    options: ["--scope", "--base", "--phase", "--override", "--thread", "--agent", "--standing", "--round"], repeatable: ["--lens", "--knowledge"], flags: ["--wait"],
    run: async (parsed, identity, context) => {
      if (parsed.flags.has("--wait")) return waitForReview(parsed.options, identity(), context);
      if (parsed.lists.has("--lens")) return runPanel(parsed, identity(), context);
      return runReview(parsed.options, identity(), context);
    },
  },
  show: {
    usage: "show [--round <number|final|final-n>]",
    summary: `Print the latest review round, or --round: who reviewed it and where its findings are. --round final is the
latest final read. For a panel, print each lens: its state, family and model, how long it ran, and its raw answer, or
its log while it runs.`,
    examples: ["fleet proof show", "fleet proof show --round 2", "fleet proof show --round final-1"],
    options: ["--round"],
    run: async ({ options }, identity, context) => {
      const directory = await reviewDirectory(context.home, identity(), roundOption(options));
      for (const line of await roundLines(directory, context)) context.print(line);
      return 0;
    },
  },
  "panel-lens": {
    usage: "panel-lens --directory <round directory> --lens <name>", summary: "Run one lens of a panel. fleet proof review starts it.", examples: [], hidden: true,
    options: ["--directory", "--lens"],
    run: async ({ options }, _, context) => {
      await runLens(required(options, "--directory", "panel-lens"), required(options, "--lens", "panel-lens"), panelIO(context));
      return 0;
    },
  },
  respond: {
    usage: "respond --round <number|final-n> <responses.md>",
    summary: `Save your answer to each finding of a finished review: fixed in which commit, or rejected and why. Number the
answers in the order of the findings, one line each, such as "1. fixed in 1a2b3c4: <how>" or "2. rejected: <why>". Each
list item of findings.md is one finding; findings without a list are one. The gate fails while a finding has no
answer. A new call replaces the earlier answer. A final read takes the id that review-start printed. The judge in fleet proof gate checks
each answer against HEAD.`,
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
date. For a gap kind, it accepts every gap of that kind. Kinds review, judge and post-deploy-watch are retired: decide
a review round with fleet proof review --agent, and those gaps with fleet decision record. The user's instructions,
~/.agents/AGENTS.md or a file in ~/.agents/guides, must hold the whole command word for word, so only the user sets
the rule, its kinds, and its date. The rule lapses on the date or when it leaves their instructions. Without options,
list the standing rules.`,
    examples: ["fleet proof standing --kind prod-shape --until 2026-11-02 --rule '<the rule, word for word>'", "fleet proof standing"],
    options: ["--kind", "--until", "--rule"],
    run: async ({ options }, _, { print, home }) => {
      if (!options.size) { for (const standing of await listStanding(home)) print(JSON.stringify(standing)); return 0; }
      for (const standing of await recordStanding(home, required(options, "--kind", "standing"), required(options, "--until", "standing"), required(options, "--rule", "standing"))) print(JSON.stringify(standing));
      return 0;
    },
  },
  gap: {
    usage: "gap --kind <kind> --reason <why it could not run>",
    summary: `Record why an owed proof could not run. It prints a question that names the gap kind and the PR, with the
options "Accept the gap" and "Keep the gap open". Ask it with your question tool. When the user chooses "Accept the
gap", record their answer with fleet decision record --mark 👤 --class proof-gap --kind <kind> --pr <owner/repo#n>:
it lands in the decision ledger and the gate counts it. A gap recorded again, such as with another reason, keeps
its acceptance. An agent's own 🤖 decision covers a gap when the PR's tier lets it, never a panel gap. A standing
rule (fleet proof standing) covers the kinds it still takes. The user's acceptance settles the kind: the gate then
ignores that kind's evidence, and the judge does not see it. Kind ci records that CI cannot run on HEAD, such as on
a fork PR. Kind panel records that the PR runs no qa-swarm panel under an exception in the user's rules; once
accepted, any finished review at HEAD covers it. A judge gap counts only decisions made after it was recorded on
HEAD.`,
    examples: ["fleet proof gap --kind prod-shape --reason 'No production read access'"],
    options: ["--kind", "--reason", "--accept", "--thread"],
    run: async ({ options }, identity, context) => {
      const kind = required(options, "--kind", "gap");
      if (options.has("--accept")) throw usageError("gap", `--accept is gone. Record the user's answer with ${recordGapCommand(identity(), kind)}`);
      const reason = required(options, "--reason", "gap");
      const gap = await recordGap(context.home, identity(), kind, reason, context.now?.());
      context.print(JSON.stringify(gap));
      context.print(askGap(identity(), kind, reason));
      return 0;
    },
  },
  gate: {
    usage: "gate [--landed] [--json]",
    summary: `Check the owed proofs, the review and the answers to its findings, and the CI of the commit on GitHub, then let
the judge weigh them. Exit 0 only on a pass: 1 means the owed proofs are not recorded, a proof is missing, the commit
is not reviewed, a finding has no answer, the commit is not the PR's head on GitHub, its checks are red or pending,
or the judge failed or was unavailable; 3 means only unaccepted gaps remain. No gap waives the head check. The last
line is the verdict and names what it covered. fleet reads the PR and its CI over GitHub's REST API. Only finding the PR of the
checkout without --repo and --pr uses gh pr view; pass both when GraphQL is out. A check that ran more than once
counts with its newest run from each app, as GitHub's required checks do. The
required checks of the base branch, from its rulesets and branch protection, decide CI; other checks print as not
required. A stacked PR whose base requires nothing is held to the default branch's required checks. When no branch
requires any, every check counts. On a draft, a required check named "<workflow> / <job>" that never reported counts
as withheld from drafts when its workflow reported other checks on the commit and all of them passed. CI is unknown
when GitHub does not answer for the rulesets or branch protection. A clean merge of the PR's base carries the review and the evidence of
its other parent forward. The review needs a finished --lens panel round on the PR, and HEAD read by a panel round or
by a review that finished after one, such as a final read; single-reviewer rounds alone never count. An accepted
panel gap (gap --kind panel) stands in for the panel. The review also carries across quiet commits: single-parent commits that only change or add
test files, named *.test.*, *.spec.*, *_test.go, *_test.py or test_*.py, or snapshots in __snapshots__, as regular
files with an unchanged mode. A deleted test, a mode change, a symlink, a comment, a file in a test folder, or a test
file whose name other code holds, such as an import of limits.test.ts, needs a review. The gate then prints "final read carried from <sha>: test-only delta", and the receipt in
carried/<HEAD>.json names the quiet commits and the reason. Evidence does not carry across quiet commits.
When those checks pass, the judge runs read-only on the reviewer's row of the model table, as fleet proof review
picks it. fleet hands it the diff from the merge base, CI, the owed kinds, the counted evidence, every review's
findings and responses, and the coding standards in ~/.agents/guides/coding-standards.md. It answers four questions:
does the evidence prove HEAD, do the owed kinds fit the diff, does the review hold, and how good is the code. A finding
holds when it is fixed, rejected for a sound reason, or parked with a reach read for a problem the diff did not
introduce. When the merge-risk skill is installed at ~/.agents/skills/merge-risk/SKILL.md, the judge also gets the PR
body and that skill, and answers a fifth question: does the merge-risk callout's grade and door follow from what the
diff measurably changes. A body without a callout passes it. A failed question or a high quality finding fails the
gate; medium and low findings are listed. The verdict is cached per set of inputs, and a later run asks an unavailable
judge again. Each run saves its proof summary for its commit, with the PR's head, base and base SHA on GitHub, the tier,
--landed, and a fingerprint of the PR's proof files, the standing rules and the ledger decisions that cover the PR.
fleet decision report prints that summary only while all of them still match. From the third failing verdict on a PR, the arbiter may escalate to the user; a judge gap on HEAD (gap
--kind judge) lets the gate pass once a decision in the ledger accepts it: the user's answer, recorded with fleet
decision record --mark 👤, or your own 🤖 decision when the PR's tier lets you. A refusal or a typed message never
accepts it. The judge reads the condition of each accepted gap and fails one that HEAD breaks; the setting
pull-requests.criticalPathFiles gives it the repository's critical-path list. The gate reads the decision ledger on
the hub and the tier from the merge-risk callout at HEAD; with the hub unreachable, no ledger decision counts and the
gate fails closed. It prints each 🤖 acceptance that lapsed. The setting
pull-requests.reviewTimeoutMinutes limits the judge, and spent quota stops it early, as for fleet proof review.
FLEET_PROOF_JUDGE replaces its command, and FLEET_PROOF_JUDGE_MODEL its model.
--json prints the proof summary instead of the lines, with the gate's exit code: each owed kind as pending, ran,
reused, carried, gap (with the decision that accepts it, or the 🤖 decision that lapsed and why), or missing; the
review and its unanswered findings; the head; CI; the tier; the judge at HEAD as pass, fail, unavailable, or skipped
when the gate's own checks fail first, with its lines and its judge gap; the lapsed and voided decision ids; and the
receipt link once one is recorded. The gate's lines and fleet decision report come from the same summary.`,
    examples: ["fleet proof gate", "fleet proof gate --landed", "fleet proof gate --json"], flags: ["--landed", "--json"],
    run: async ({ flags }, identity, context) => {
      const { print, home } = context;
      const head = identity();
      const record = await startGateRun(home, head);
      let gate: FinalGate;
      try {
        gate = await finalGate(head, context, { landed: flags.has("--landed") });
      } catch (error) {
        await record({ code: 1, reason: String((error as Error).message ?? error).split("\n")[0]! }).catch(() => {});
        throw error;
      }
      await record({ code: gate.code, reason: gate.reason });
      if (flags.has("--json")) print(JSON.stringify(gate.summary));
      else for (const line of [...gate.lines, gate.verdict]) print(line);
      return gate.code;
    },
  },
  miss: {
    usage: `miss --source ${missSources.join("|")} --finding <what the reviewer should have flagged> [--file <path> [--line <number>]] [--url <link>]`,
    summary: `Record a reviewer miss: a problem that a human reviewer, a review bot, CI, a rollback, or a revert found after
fleet proof review read the commit and said nothing about it. --commit is the reviewed commit that already held the
problem. --finding says in one or two sentences what the reviewer should have flagged; record only a problem a
person has checked. The CLI refuses a commit that no finished review of the PR read, because then no reviewer
missed it. Each case keeps the diff range the review read, the PR title and description, and the source, as one
JSON line in ${missesPath("~")}. fleet proof eval reruns the reviewer on every case.`,
    examples: [
      "fleet proof miss --source human --finding 'The retry loop sends the email twice when the first send times out' --file src/send.ts --line 42 --url https://github.com/owner/name/pull/7#discussion_r1",
      "fleet proof miss --pr 7 --commit 1a2b3c4 --source revert --finding 'The migration drops the index the dashboard query needs'",
    ],
    options: ["--source", "--finding", "--file", "--line", "--url"],
    run: async ({ options }, identity, context) => {
      const { home, print, run, now } = context;
      const source = missSource(required(options, "--source", "miss"));
      const finding = required(options, "--finding", "miss");
      const line = options.has("--line") ? positive(options.get("--line")!, "--line", "miss") : undefined;
      if (line !== undefined && !options.has("--file")) throw usageError("miss", "--line needs --file");
      const head = identity();
      const review = await reviewOfCommit(home, head);
      if (!review) throw new Error(`No finished review of ${head.repository}#${head.pr} read ${short(head.commit)}, so no reviewer missed it there. Pass --commit with the reviewed commit that held the problem`);
      const base = review.from ?? mergeBase(head, run);
      if (base === head.commit) throw new Error(`Cannot rebuild the diff the review read: the base of ${head.repository}#${head.pr} already contains ${short(head.commit)}`);
      const pr = pullRequestDetails(head, run);
      const miss = await recordMiss(home, {
        repo: head.repository, pr: head.pr, commit: head.commit, source, finding, file: options.get("--file"), line, url: options.get("--url"),
        base, head: head.commit, scope: review.scope, round: review.label, reviewer: review.reviewer, title: pr.title, body: pr.body,
      }, now?.() ?? new Date());
      print(JSON.stringify({ id: miss.id, repo: miss.repo, pr: miss.pr, commit: miss.commit, source: miss.source, round: miss.round, path: missesPath(home) }));
      return 0;
    },
  },
  eval: {
    usage: "eval [--checkout <owner/name>=<path>]... [--case <id>]... [--limit <number>]",
    summary: `Rerun the reviewer of fleet proof review on every recorded miss and score it. For each case, fleet checks out
the reviewed commit in a temporary worktree of the case's repository, builds the same prompt from the diff the
review read, and runs the reviewer that fleet proof review picks for that PR. A cheap judge, the lookup row of the
model table, answers whether the findings name the known problem: caught or missed. The current checkout serves
the repository its remotes point at; --checkout names a checkout of another one. A case without a checkout, or
whose commits the checkout lacks, is skipped and listed. At most pull-requests.panelSlots reviewers run at once on
this machine, shared with panels.
fleet prints recall per source and overall, and compares it with the previous run on the cases both runs scored.
It appends the run to ${evalsPath("~")}: the date, the reviewer and judge models, a hash of the prompt template, a
hash of PANEL.md, the coding standards, and the skill references, and each case's verdict. FLEET_PROOF_REVIEWER
and FLEET_PROOF_REVIEWER_MODEL score a candidate reviewer; FLEET_PROOF_EVAL_JUDGE and FLEET_PROOF_EVAL_JUDGE_MODEL
change the judge. Exit 1 when no case was scored.`,
    examples: [
      "fleet proof eval --limit 3",
      "fleet proof eval --checkout owner/name=$HOME/name",
      "FLEET_PROOF_REVIEWER_MODEL=candidate-model fleet proof eval --case 1a2b3c4d5e",
    ],
    options: ["--limit"], repeatable: ["--checkout", "--case"],
    run: async ({ options, lists }, _, context) => runEval(options, lists, context),
  },
  "review-start": {
    usage: "review-start [--scope full|fixes|final] [--base <reviewed-sha>] [--phase review|babysit] [--override <dated quote> [--thread <id>] | --agent <reason>]",
    summary: `Reserve a review round before you dispatch its reviewers. Round 1 is --scope full and takes no --base. A later
round is --scope fixes, and a final read is --scope final; both take --base with the commit of the latest finished
review. The printed id names the round for review-finish and respond. A final read of a HEAD that the gate carries
across quiet commits is refused, unless --agent with your reason, or the user's --override, asks for it.
A later round with --agent, or the user's --override, may be --scope full: it reviews
the whole PR diff at HEAD again, such as after a restack.
${overrideHelp}`,
    examples: ["fleet proof review-start --scope full", "fleet proof review-start --scope fixes --base 1a2b3c4", "fleet proof review-start --scope final --base 1a2b3c4"],
    options: ["--scope", "--base", "--phase", "--override", "--thread", "--agent", "--standing"],
    run: async ({ options }, identity, context) => {
      const head = identity();
      const { round, id, directory } = await unrecordedRound(options, head, context) ?? await reserveRound(options, head, context, "author");
      await roundStep(directory, context, async () => {
        await takeOverride(directory, options, head, context);
        await recordRound(directory, context);
      });
      context.print(JSON.stringify({ round, id, directory }));
      return 0;
    },
  },
  "review-finish": {
    usage: "review-finish --round <number|final-n> --reviewer <model> <findings.md>",
    summary: `Save the findings of a reserved round after its reviewers finish. --round takes the id that review-start
printed. --reviewer names the model that wrote them; the gate prints it. The findings file must not be empty; write
"No findings." when the reviewer found none. When the round's decision is not recorded yet, review-finish records it
first and needs the hub; a round whose decision is recorded finishes without it.`,
    examples: ["fleet proof review-finish --round 1 --reviewer gpt-6.1-sol findings.md", "fleet proof review-finish --round final-1 --reviewer claude-opus-5-5 findings.md"],
    options: ["--round", "--findings", "--reviewer"],
    run: async ({ options, files }, identity, context) => {
      const findings = options.has("--findings") ? [options.get("--findings")!, ...files] : files;
      if (findings.length !== 1) throw usageError("review-finish", "Pass one findings file");
      const round = roundId(required(options, "--round", "review-finish"));
      const reviewer = required(options, "--reviewer", "review-finish");
      const head = identity();
      const directory = await reviewDirectory(context.home, head, round);
      await requireReservation(directory);
      await roundStep(directory, context, async () => {
        await recordRound(directory, context);
        context.print(await finishReview(context.home, head, round, resolve(context.cwd, findings[0]!), reviewer));
      });
      return 0;
    },
  },
};

type SingleRound = { round: number | "final"; id: string; directory: string; scope: string; from?: string };

async function runReview(options: Map<string, string>, head: ProofIdentity, context: CommandContext) {
  const { home, run } = context;
  const author = await authorOf(home, head);
  const pending = await unfinishedReview(home, head, "fleet");
  if (pending) requireSameRequest(pending, options, run);
  const reserved: SingleRound = pending
    ? { round: pending.reservation.round, id: basename(pending.directory), directory: pending.directory, scope: pending.reservation.scope, from: pending.reservation.from ?? rangeStart(pending.reservation.scope, pending.reservation.base, head, run) }
    : await reserveFleetReview(options, head, context);
  return roundStep(reserved.directory, context, async () => {
    if (await readPlan(reserved.directory) || await stagedPlan(reserved.directory)) throw new Error(`${reserved.directory} is an unfinished panel. Rerun it with the same fleet proof review --lens command, or wait for it with --wait`);
    await takeOverride(reserved.directory, options, head, context);
    await recordRound(reserved.directory, context);
    if (existsSync(join(reserved.directory, "findings.md"))) return printSavedReview(reserved, context);
    return askReviewer(reserved, head, author, context);
  });
}

async function printSavedReview({ round, id, directory }: SingleRound, { print }: CommandContext) {
  const reservation = await readReservation(directory);
  print(JSON.stringify({ round, id, directory, reviewer: reservation?.reviewer }));
  print((await readFile(join(directory, "findings.md"), "utf8")).trim());
  const anchors = await readFile(join(directory, "anchors.md"), "utf8").catch(() => "");
  if (anchors) print(`\n${anchors.trim()}`);
  return 0;
}

async function askReviewer(reserved: SingleRound, head: ProofIdentity, author: Family, context: CommandContext) {
  const { print, home, cwd, env, run } = context;
  const row = reviewerRow(author, env);
  const limit = numberSetting("pull-requests.reviewTimeoutMinutes", env) * 60_000;
  const rubric = await readRubric(home);
  const from = reserved.from!;
  const pr = pullRequestDetails(head, run);
  const { files, leftOut, diff } = reviewRange(run, from, head.commit, mergeBase(head, run));
  const rules = reviewRules(files, baseTip(head, run), run);
  const diffFile = join(reserved.directory, "diff.patch");
  await writeFile(diffFile, diff, { mode: 0o600 });
  const prompt = reviewPrompt({ scope: reserved.scope, from, commit: head.commit, diff, diffFile, note: leftOutNote(leftOut), crossFamily: familyOf(row) !== author, title: pr.title, body: pr.body, rubric, references: skillReferences(home), reviewRules: rules });
  const answer = await askModel("reviewer", row, { prompt, cwd: topLevel(run) ?? cwd, readable: [join(home, ".agents/skills"), reserved.directory] }, env, limit);
  const label = reserved.round === "final" ? "The final read" : `Round ${reserved.round}`;
  if (!answer.ok && isQuotaExhausted(answer.cause)) {
    print(`The reviewer ${answer.model} stopped: ${answer.cause}. ${label} stays reserved; run fleet proof review again once the quota is back.`);
    return quotaExitCode;
  }
  if (!answer.ok) throw new Error(`The reviewer ${answer.model} gave no findings (${answer.cause}). ${label} stays reserved; run fleet proof review again to retry it`);
  const anchors = anchorCheck(answer.text, diff, await reviewRecords(home, head));
  await storeCapturedFindings(reserved.directory, head, roundId(reserved.id), answer.text, answer.model);
  if (anchors) await writeFile(join(reserved.directory, "anchors.md"), anchors + "\n", { mode: 0o600 });
  print(JSON.stringify({ round: reserved.round, id: reserved.id, directory: reserved.directory, reviewer: answer.model }));
  print(answer.text.trim());
  if (anchors) print(`\n${anchors}`);
  return 0;
}

async function reserveFleetReview(options: Map<string, string>, head: ProofIdentity, context: CommandContext) {
  const scope = options.get("--scope") ?? "full";
  if (["fixes", "final"].includes(scope) && !options.has("--base")) throw usageError("review", "--scope fixes and --scope final need --base with the commit of the latest finished review");
  return reserveRound(options, head, context, "fleet");
}

async function reserveRound(options: Map<string, string>, head: ProofIdentity, context: CommandContext, capturedBy: CapturedBy) {
  await settleStrandedRounds(head, context);
  const scope = options.get("--scope") ?? "full";
  const base = options.has("--base") ? resolveCommit(options.get("--base")!, context.run) : undefined;
  const from = rangeStart(scope, base, head, context.run);
  const { decision, ...permit } = await decisionOf(options, head, context);
  const reserved = await startReview(context.home, head, { scope, base, from, ...permit, decision, phase: options.get("--phase"), cleanBaseMerge: cleanBaseMerge(head, context.run), quietCommit: quietCommitIn(context.run), capturedBy, lock: async (directory) => lockNewRound(directory, await context.lock()) });
  return { ...reserved, scope, from };
}

async function unrecordedRound(options: Map<string, string>, head: ProofIdentity, context: CommandContext) {
  const pending = await unfinishedReview(context.home, head, "author");
  if (!pending?.reservation.decision || pending.reservation.recorded) return undefined;
  requireSameRequest(pending, options, context.run);
  return { round: pending.reservation.round, id: basename(pending.directory), directory: pending.directory };
}

function requireSameRequest({ reservation, directory }: { reservation: Reservation; directory: string }, options: Map<string, string>, run: Run) {
  if (!reservation.decision || reservation.recorded) return;
  const reserved = reservedOptions(reservation);
  if (reserved !== requestedOptions(options, reservation, run)) throw new Error(`Review round ${basename(directory)} at this HEAD is reserved with ${reserved}, and its decision is not recorded yet. Run its command again with ${reserved} to record it, or remove ${directory} to drop it`);
}

const reservedOptions = ({ scope, base, phase }: Reservation & { phase?: string }) =>
  [`--scope ${scope}`, base && `--base ${base}`, scope === "final" && `--phase ${phase ?? "review"}`].filter(Boolean).join(" ");

function requestedOptions(options: Map<string, string>, reservation: Reservation, run: Run) {
  const scope = options.get("--scope") ?? "full";
  const base = options.has("--base") ? resolveCommit(options.get("--base")!, run) : undefined;
  return reservedOptions({ ...reservation, scope, base, phase: options.get("--phase") });
}

async function settleStrandedRounds(head: ProofIdentity, context: CommandContext) {
  for (const directory of await roundDirectories(context.home, head)) {
    if (!await unrecordedElsewhere(directory, head.commit)) continue;
    await roundStep(directory, context, async () => {
      const decision = await unrecordedElsewhere(directory, head.commit);
      if (!decision) return;
      if (await ledgerHolds(ledgerOf(context), decision.id)) await markRecorded(directory);
      else await rm(directory, { recursive: true, force: true });
    }).catch(unless(RoundBusy, HubUnreachable, RoundGone));
  }
}

const unless = (...kinds: (new (...args: never[]) => Error)[]) => (error: unknown) => { if (!kinds.some((kind) => error instanceof kind)) throw error; };

const lockOwner = (context: ProofContext): LockOwner => ({ pid: context.pid ?? process.pid, now: context.now ?? (() => new Date()), startTime: context.startTime ?? processStart });

const roundStep = async <T>(directory: string, context: CommandContext, step: () => Promise<T>) => withRoundLock(directory, await context.lock(), step);

async function takeOverride(directory: string, options: Map<string, string>, head: ProofIdentity, context: CommandContext) {
  const reservation = await readReservation(directory);
  if (!options.has("--override") || !reservation?.decision || reservation.recorded || reservation.decision.mark !== "🤖") return;
  const { decision } = await decisionOf(options, head, context);
  await writeJson(join(directory, "round.json"), { ...reservation, decision } satisfies Reservation);
}

async function recordRound(directory: string, context: CommandContext) {
  const reservation = await readReservation(directory);
  if (!reservation?.decision || reservation.recorded) return;
  try { await appendOnce(ledgerOf(context), reservation.decision); }
  catch (error) { if (error instanceof AnswerTaken) await rm(directory, { recursive: true, force: true }); throw error; }
  await markRecorded(directory);
}

const rangeStart = (scope: string, base: string | undefined, head: ProofIdentity, run: Run) => scope === "full" ? mergeBase(head, run) : base;

const waitPolls = 108;
const pollInterval = 5_000;
const proofEntry = resolve(import.meta.dir, "../commands/proof.ts");

const panelIO = (context: CommandContext): PanelIO => ({
  ...lockOwner(context), pid: process.pid, env: context.env, pause: pausing(context), slots: join(ledgerRoot(context.home), ".panel-slots"),
  slotCount: numberSetting("pull-requests.panelSlots", context.env), limit: reviewLimit(context.env),
});

const pausing = ({ pause }: ProofContext) => pause ?? (() => Bun.sleep(pollInterval));

async function startLens(directory: string, name: string, context: CommandContext) {
  const detach = context.detach ?? detachFleet(context);
  await recordWorker(directory, name, await detach(["panel-lens", "--directory", directory, "--lens", name], lensLog(directory, name)));
}

const detachFleet = ({ cwd, env }: CommandContext) => async (args: string[], log: string) => {
  const output = openSync(log, "a", 0o600);
  try {
    const child = Bun.spawn([process.execPath, proofEntry, ...args], { cwd, env: env as Record<string, string>, stdin: "ignore", stdout: output, stderr: output, detached: true });
    child.unref();
    return child.pid;
  } finally { closeSync(output); }
};

async function runPanel({ options, lists }: Parsed, head: ProofIdentity, context: CommandContext) {
  const { home, print, env } = context;
  const author = await authorOf(home, head);
  const guide = await readPanelGuide(home);
  const knowledge = await knowledgeOf(lists.get("--knowledge") ?? [], context.cwd);
  const lenses = lists.get("--lens")!.map((argument) => resolveLens(guide, argument, author, knowledge, env));
  const pending = await unfinishedReview(context.home, head, "fleet");
  if (pending) requireSameRequest(pending, options, context.run);
  const directory = pending ? await rerunPanel(pending, options, head, lenses, guide, context) : await reservePanel(options, head, lenses, guide, context);
  const round = (await readJson<{ round: number | "final" }>(join(directory, "round.json"), { round: 0 })).round;
  print(JSON.stringify({ round, directory, lenses: lenses.map(({ name, family }) => ({ name, family })) }));
  print("The lenses run in the background. Run fleet proof review --wait for the findings, and fleet proof show to see each lens.");
  return 0;
}

const castOf = ({ family, row }: Lens, env: Record<string, string | undefined>) => ({ family, row, model: modelLabel("reviewer", row, env) });

async function reservePanel(options: Map<string, string>, head: ProofIdentity, lenses: Lens[], guide: PanelGuide, context: CommandContext) {
  const rubric = await readRubric(context.home);
  const reserved = await reserveFleetReview(options, head, context);
  return roundStep(reserved.directory, context, async () => {
    try {
      const { plan, briefs } = await panelBriefs(reserved, head, lenses, guide, rubric, context);
      await stagePanel(reserved.directory, plan, briefs);
    } catch (error) {
      await rm(reserved.directory, { recursive: true, force: true });
      throw error;
    }
    return recordAndStart(reserved.directory, context);
  });
}

async function recordAndStart(directory: string, context: CommandContext) {
  await recordRound(directory, context);
  return startIdleLenses(directory, context);
}

async function startIdleLenses(directory: string, context: CommandContext) {
  await publishPanel(directory);
  for (const lens of (await readPlan(directory))!.lenses) if (await lensIdle(directory, lens.name)) await startLens(directory, lens.name, context);
  return directory;
}

async function panelBriefs(reserved: { directory: string; from?: string }, head: ProofIdentity, lenses: Lens[], guide: PanelGuide, rubric: string, context: CommandContext) {
  const { home, cwd, env, run } = context;
  const from = reserved.from!;
  const pr = pullRequestDetails(head, run);
  const owed = await readOwed(home, head);
  const settled = (await reviewRecords(home, head)).filter((review) => review.responses).map((review) => `${review.label}:\n${review.responses!.trim()}`).join("\n\n");
  const { files: changedFiles, leftOut, diff } = reviewRange(run, from, head.commit, mergeBase(head, run));
  const diffFile = join(reserved.directory, "diff.patch");
  await writeFile(diffFile, diff, { mode: 0o600 });
  const input = {
    title: pr.title, body: pr.body, base: pr.baseRefName, from, commit: head.commit, diff, diffFile, note: leftOutNote(leftOut), settled,
    owed: owed?.none ? `none (${owed.none.reason})` : owed?.kinds.join(", ") || "none recorded", rubric,
  };
  const rules = reviewRules(changedFiles, baseTip(head, run), run);
  const briefed = lenses.map((lens) => ({ ...lens, knowledge: [rules, lens.knowledge].filter(Boolean).join("\n\n") }));
  const plan: Plan = {
    lenses: lenses.map((lens) => ({ name: lens.name, title: lens.title, ...castOf(lens, env) })),
    changedFiles, from, cwd: topLevel(run) ?? cwd, readable: [join(home, ".agents/skills"), reserved.directory],
  };
  return { plan, briefs: new Map(briefed.map((lens) => [lens.name, lensBrief(guide, lens, input)])) };
}

async function rerunPanel(pending: { directory: string; reservation: { scope: string; base?: string; from?: string } }, options: Map<string, string>, head: ProofIdentity, lenses: Lens[], guide: PanelGuide, context: CommandContext) {
  const { directory, reservation } = pending;
  const plan = await readPlan(directory) ?? await stagedPlan(directory);
  if (!plan) throw new Error(`${directory} is reserved for one reviewer. Run fleet proof review without --lens to retry it`);
  const planned = plan.lenses.map((lens) => lens.name);
  if (lenses.map((lens) => lens.name).sort().join() !== [...planned].sort().join()) throw new Error(`The unfinished round runs the lenses ${planned.join(", ")}. Pass the same --lens set to rerun its failed lenses`);
  return roundStep(directory, context, async () => {
    await takeOverride(directory, options, head, context);
    await recordRound(directory, context);
    if (await readPlan(directory)) {
      const casts = new Map(lenses.map((lens) => [lens.name, castOf(lens, context.env)]));
      const from = reservation.from ?? rangeStart(reservation.scope, reservation.base, head, context.run);
      await requeueFailed(directory, casts, await panelBriefs({ directory, from }, head, lenses, guide, await readRubric(context.home), context));
    }
    return startIdleLenses(directory, context);
  });
}

async function knowledgeOf(values: string[], cwd: string) {
  const knowledge = new Map<string, string[]>();
  for (const value of values) {
    const match = /^([a-z0-9-]+)=(.+)$/.exec(value);
    if (!match) throw usageError("review", `--knowledge takes <lens>=<file>, not ${value}`);
    const [, lens = "", file = ""] = match;
    knowledge.set(lens, [...knowledge.get(lens) ?? [], (await readFile(resolve(cwd, file), "utf8")).trim()]);
  }
  return knowledge;
}

async function waitForReview(options: Map<string, string>, head: ProofIdentity, context: CommandContext) {
  const pending = options.has("--round") ? undefined : await unfinishedReview(context.home, head, "fleet");
  const directory = pending?.directory ?? await reviewDirectory(context.home, head, roundOption(options));
  await requireReservation(directory);
  await startStaged(directory, context);
  const restart = (name: string) => roundStep(directory, context, async () => { if (await lensIdle(directory, name)) await startLens(directory, name, context); }).catch(unless(RoundBusy));
  const code = await waitForPanel(directory, panelIO(context), restart, waitPolls);
  for (const line of await roundLines(directory, context)) context.print(line);
  if (code === 0) context.print(await readFile(join(directory, "findings.md"), "utf8"));
  if (code === 1) context.print("A lens failed, and the round stays unfinished. Run the same fleet proof review --lens command to rerun the failed lenses.");
  if (code === 2) context.print("Lenses still run. Run fleet proof review --wait again.");
  if (code === quotaExitCode) context.print("A lens stopped on spent quota, and the round stays unfinished. Run the same fleet proof review --lens command once the quota is back, or move the lens to the family that is up with :same or :other.");
  return code;
}

async function startStaged(directory: string, context: CommandContext) {
  for (let poll = 0; !await readPlan(directory); poll++) {
    try { await roundStep(directory, context, async () => { if (await stagedPlan(directory)) await recordAndStart(directory, context); }); return; }
    catch (error) { if (!(error instanceof RoundBusy) || poll >= waitPolls) throw error; }
    await pausing(context)();
  }
}

const evalJudgeLimit = 180_000;

async function runEval(options: Map<string, string>, lists: Map<string, string[]>, context: CommandContext) {
  const { home, env, print, now } = context;
  const limit = options.has("--limit") ? positive(options.get("--limit")!, "--limit", "eval") : undefined;
  const wanted = lists.get("--case");
  const recorded = await readMisses(home);
  if (!recorded.length) throw new Error(`No misses are recorded in ${missesPath(home)}. Record one with fleet proof miss`);
  const unknown = wanted?.find((id) => !recorded.some((miss) => miss.id === id));
  if (unknown) throw usageError("eval", `No recorded case ${unknown}`);
  const cases = recorded.filter((miss) => !wanted || wanted.includes(miss.id)).slice(0, limit);
  const rubric = await readRubric(home);
  const references = skillReferences(home);
  const judgeRow = modelFor("lookup", env);
  const reviewLimitMs = reviewLimit(env);
  const reviewerOf = async (miss: { repo: string; pr: number; commit: string }) => {
    const author = await authorOf(home, { repository: miss.repo, pr: miss.pr, commit: miss.commit });
    return { author, row: reviewerRow(author, env) };
  };
  const io: EvalIO = {
    checkoutOf: checkoutsOf(lists.get("--checkout") ?? [], context), runIn: (cwd) => runIn(cwd, env),
    crossFamily: async (miss) => { const { author, row } = await reviewerOf(miss); return familyOf(row) !== author; },
    review: async (miss, prompt, cwd, readable, slot) => askModel("reviewer", (await reviewerOf(miss)).row, { prompt, cwd, readable: [join(home, ".agents/skills"), readable], started: slot.recordReviewer }, env, reviewLimitMs),
    judge: (prompt, slot) => askModel("eval-judge", judgeRow, { prompt, cwd: tmpdir(), started: slot.recordReviewer }, env, evalJudgeLimit),
    slot: (work) => withSlot(panelIO(context), work), rubric, references,
  };
  const results = await scoreCases(cases, io);
  const inputs = [rubric, (await panelGuideText(home))?.text ?? "", ...await Promise.all(references.map((path) => readFile(path, "utf8").catch(() => "")))];
  const reviewers = [...new Set(results.flatMap((result) => result.reviewer ? [result.reviewer] : []))];
  const evaluation = { at: (now?.() ?? new Date()).toISOString(), reviewer: reviewers.join(", ") || "none", judge: modelLabel("eval-judge", judgeRow, env), promptHash: promptTemplateHash(), inputsHash: hashOf(inputs), cases: results };
  const previous = (await readRuns(home)).at(-1);
  for (const line of reportLines(evaluation, previous)) print(line);
  if (!results.some((result) => result.outcome === "caught" || result.outcome === "missed")) return 1;
  await saveRun(home, evaluation);
  print(`saved: ${evalsPath(home)}`);
  return 0;
}

function checkoutsOf(values: string[], { cwd, run }: CommandContext) {
  const named = new Map(values.map((value) => {
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)=(.+)$/.exec(value);
    if (!match) throw usageError("eval", `--checkout takes <owner/name>=<path>, not ${value}`);
    return [match[1]!.toLowerCase(), resolve(cwd, match[2]!)] as const;
  }));
  const here = topLevel(run);
  return (repository: string) => named.get(repository.toLowerCase()) ?? (here && remotesOf(repository, run).length ? here : undefined);
}

function positive(value: string, option: string, name: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw usageError(name, `${option} takes a positive whole number, not ${value}`);
  return number;
}

async function roundLines(directory: string, { now }: CommandContext) {
  const round = await readJson<{ round: number | "final"; commit: string; reviewer?: string; capturedBy?: string; standing?: { reason: string; until: string }; decision?: { mark: string; id: string } } | undefined>(join(directory, "round.json"), undefined);
  if (!round) throw new Error(`${directory} has no reservation`);
  const finished = round.reviewer ? `finished by ${round.reviewer}, ${round.capturedBy === "fleet" ? "captured by fleet" : "saved by the author"}: ${join(directory, "findings.md")}` : "reserved, no findings yet";
  const header = `${round.round === "final" ? "final read" : `round ${round.round}`} on ${short(round.commit)}: ${finished}`;
  const anchors = join(directory, "anchors.md");
  const standing = round.standing ? [`accepted by the standing rule until ${round.standing.until}: ${round.standing.reason}`] : [];
  if (round.decision) standing.push(`decided by ${round.decision.mark} decision ${round.decision.id}`);
  return [header, ...(existsSync(anchors) ? [`anchor check by fleet: ${anchors}`] : []), ...standing, ...(await readPlan(directory) ? await panelLines(directory, now?.() ?? new Date()) : [])];
}

function roundOption(options: Map<string, string>) {
  const round = options.get("--round");
  return round === undefined ? undefined : round === "final" ? "final" : roundId(round);
}

async function decisionOf(options: Map<string, string>, head: ProofIdentity, context: CommandContext): Promise<{ arbiter: Arbiter; limits: { free: number; ceiling: number }; decision?: Decision }> {
  const rest = { arbiter: arbiterOf(context), limits: { free: numberSetting("pull-requests.freeReviews", context.env), ceiling: numberSetting("pull-requests.reviewCeiling", context.env) } };
  const words = options.get("--override");
  const reason = options.get("--agent") ?? options.get("--standing");
  if (options.has("--agent") && options.has("--standing")) throw new Error("Pass --agent, not --standing too: --standing is its old name");
  if (words !== undefined && reason !== undefined) throw new Error("Pass --override with the user's answer or --agent with your reason, not both");
  if (words === undefined && reason === undefined) return rest;
  const ask = { class: "review" as const, prs: [head] };
  const lead = `${roundQuestion} ${head.repository}#${head.pr}:`;
  if (reason !== undefined && !reason.trim()) throw new Error("--agent needs your reason for this review");
  const ledger = ledgerOf(context);
  const decision = words !== undefined
    ? await hearUser({ ...ask, mark: "👤", words, thread: options.get("--thread"), fits: (heard) => requireChoice(heard, lead, [runOption, stopOption], "Stop the review loop") }, context, ledger)
    : await decideAlone({ ...ask, question: `Run another review round of ${refText(head)} at ${short(head.commit)}?`, answer: `Run it: ${reason}`, rejected: "Ask the user", reason: reason!, thread: options.get("--thread") }, context, ledger);
  return { ...rest, decision };
}

function resolveAuthor(requested: string | undefined, env: Record<string, string | undefined>): Family | undefined {
  const session = sessionFamily(env);
  const author = requested === undefined ? undefined : family(requested);
  if (author && session && author !== session) throw new Error(`--author ${author} contradicts the session: this session is ${session}`);
  return author ?? session;
}

const identityHelp = `Every command works on the PR of the current branch and its HEAD. Pass --repo owner/name, --pr number,
or --commit to choose others. --commit and --base take any commit Git resolves here, such as a short SHA.`;
const runIdentityHelp = `run works on the PR of the current branch. Pass --repo owner/name and --pr number to choose another. It
reads HEAD from Git and takes no --commit.`;
const kindsHelp = "Kinds: live-run, ui-walk, prod-shape, cross-version, shadow-diff, post-deploy-watch. A gap also takes ci, judge, and panel. A standing rule takes none of review, judge and post-deploy-watch.";

function overview() {
  const lines = Object.values(subcommands).filter((command) => !command.hidden).map((command) => `  fleet proof ${command.usage}`);
  return [`Usage: fleet proof <command> [--repo owner/name] [--pr number] [--commit sha]`, ...lines, "", identityHelp, kindsHelp,
    "Run fleet proof <command> --help for its details and an example."].join("\n");
}

function help(name: string, command: Subcommand) {
  const identity = command.takesCommand ? "[--repo owner/name] [--pr number]" : "[--repo owner/name] [--pr number] [--commit sha]";
  return [`Usage: fleet proof ${command.usage} ${identity}`, "", command.summary, "", command.takesCommand ? runIdentityHelp : identityHelp,
    ...(["save", "run", "require", "gap", "standing"].includes(name) ? [kindsHelp] : []), "", "Examples:", ...command.examples.map((example) => `  ${example}`)].join("\n");
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
  const parsed: Parsed = { options: new Map(), lists: new Map(), flags: new Set(), files: [] };
  while (args.length) {
    const arg = args.shift()!;
    if (command.flags?.includes(arg)) parsed.flags.add(arg);
    else if (valued.includes(arg) || command.repeatable?.includes(arg)) {
      const value = args.shift();
      if (value === undefined || value.startsWith("--")) throw usageError(name, `${arg} needs a value`);
      if (valued.includes(arg)) parsed.options.set(arg, value);
      else parsed.lists.set(arg, [...parsed.lists.get(arg) ?? [], value]);
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

const short = (commit: string) => commit.slice(0, 7);

export async function proofCommand(args: string[], context: ProofContext): Promise<number> {
  const name = args.shift();
  if (name === undefined || ["help", "--help", "-h"].includes(name)) {
    if (name === undefined) throw new Error("Name a command. Run fleet proof --help");
    context.print(overview());
    return 0;
  }
  const command = subcommands[name];
  if (!command) throw new Error(`Unknown command ${name}. Run fleet proof --help`);
  const split = args.indexOf("--");
  const own = split < 0 ? args : args.slice(0, split);
  if (own.includes("--help") || own.includes("-h")) { context.print(help(name, command)); return 0; }
  if (split >= 0 && !command.takesCommand) throw usageError(name, "Unknown option --");
  const run = runIn(context.cwd, context.env);
  const parsed = { ...parse(name, command, own), ...split >= 0 ? { command: args.slice(split + 1) } : {} };
  let identity: ProofIdentity | undefined;
  let lock: Promise<RoundLock> | undefined;
  return command.run(parsed, () => identity ??= resolveIdentity(parsed.options, run), { ...context, run, lock: () => lock ??= roundLock(lockOwner(context)) });
}
