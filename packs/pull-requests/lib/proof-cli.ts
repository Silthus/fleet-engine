import { closeSync, existsSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { askGap, authorOf, finishReview, judgeDirectory, judgeGap, ledgerRoot, listStanding, parseVerdict, proofDirectory, proofGate, readJson, readOwed, recordGap, recordStanding, requireNone, requireProofs, respondToReview, reuseProof, reviewDirectory, reviewOfCommit, reviewRecords, roundId, saveProof, standingFor, startReview, storeCapturedFindings, unfinishedFleetReview, type Arbiter, type CiResult, type CleanBaseMerge, type ProofIdentity, type PushedHead } from "./proof.ts";
import { askModel, family, familyOf, modelLabel, readRubric, reviewerRow, sessionFamily, skillReferences, type Family } from "./proof-models.ts";
import { judge } from "./proof-judge.ts";
import { lensBrief, lensLog, panelGuideText, panelLines, planPanel, readPanelGuide, readPlan, recordWorker, requeueFailed, resolveLens, runLens, waitForPanel, withSlot, type Lens, type PanelGuide, type PanelIO } from "./proof-panel.ts";
import { evalsPath, promptTemplateHash, readRuns, reportLines, saveRun, scoreCases, type EvalIO } from "./proof-eval.ts";
import { hashOf, missesPath, missSource, missSources, readMisses, recordMiss } from "./proof-misses.ts";
import { githubRequest, publishProof, type GitHub } from "./proof-publish.ts";
import { reviewPrompt } from "./proof-review.ts";
import { anchorCheck } from "./finding-anchors.ts";
import { reviewRules } from "./review-rules.ts";
import { listenIn, withoutThread, type ThreadWords } from "./proof-answers.ts";
import { modelFor } from "../../base/lib/models.ts";
import { numberSetting } from "../../base/lib/settings.ts";
import { t3StatePath } from "../../base/lib/prune.ts";
import { readThreadWords, t3UserData, withT3Session } from "../../base/lib/t3/index.ts";

export type ProofContext = {
  home: string; cwd: string; env: Record<string, string | undefined>; print: (text: string) => void; now?: () => Date; threadWords?: ThreadWords;
  detach?: (args: string[], log: string) => Promise<number>; pause?: () => Promise<void>; github?: GitHub;
};
type Result = { code: number; stdout: string; stderr: string };
type Run = (command: string[]) => Result;
type Parsed = { options: Map<string, string>; lists: Map<string, string[]>; flags: Set<string>; files: string[] };
type CommandContext = ProofContext & { run: Run };
type Subcommand = {
  usage: string; summary: string; examples: string[]; options?: string[]; repeatable?: string[]; flags?: string[]; hidden?: boolean;
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
    usage: "review [--lens <name>[:same|:other]]... [--knowledge <lens>=<file>]... [--scope full|fixes|final] [--base <reviewed-sha>] [--phase review|babysit] [--override <dated quote> --thread <id> | --standing <reason>] | review --wait [--round <number|final>]",
    summary: `Reserve a review round and run the reviewer yourself, read-only, from the model table of your AI plan: the review
row for a PR that Claude wrote, and the review-codex row for a PR that Codex wrote when the table has one, else the
review row. On the both plan that reviewer is the family that did not write the PR; on a single plan it is a fresh
session of that provider. fleet builds the prompt from the diff, the PR title and description, and the coding
standards in ~/.agents/guides/coding-standards.md, and saves the reviewer's answer as the findings. fleet checks each
finding's anchor against the diff and prints the result after the findings; it keeps it apart, in anchors.md. Answer them with fleet proof respond. Scope and --base work as for
review-start. When the reviewer gives no answer, the round stays reserved and the next fleet proof review on the same
commit retries it. The setting pull-requests.reviewTimeoutMinutes limits the reviewer. FLEET_PROOF_REVIEWER replaces
its command, and FLEET_PROOF_REVIEWER_MODEL its model.

With --lens, the round is a qa-swarm panel: one reviewer per lens, each with the Brief of the qa-swarm PANEL.md in
~/.agents/skills/qa-swarm, filled by fleet, and the lens's hunting grounds. A lens runs on the family of its PANEL.md
lane: the fresh-eyes lane on the author's family, the others on the reviewer above. :same or :other picks the family.
--knowledge adds the repo's review material for a lens, and gives the text of a Team perspective that PANEL.md does
not list. fleet starts the lenses in the background and returns at once; at most pull-requests.panelSlots reviewers
run at once on this machine, and the rest wait. Each raw answer is kept in lenses/<name>.md. A lens that ends without
a FINDINGS block or a COVERED list of every changed file runs once more; when it fails again, the round stays
unfinished with the cause, and the same review --lens command reruns the failed lenses; :same or :other moves a
failed lens to the family that is up when the other has an outage. When every lens is done, fleet joins the answers
under one heading per lens as the round's findings.
--wait waits up to 9 minutes for the panel of the unfinished round, the latest round, or --round, and prints each
lens. Exit 0 when the round is finished, with its findings; 1 when a lens failed; 2 when lenses still run, so run
--wait again. It restarts a lens whose worker died.
${overrideHelp}`,
    examples: ["fleet proof review", "fleet proof review --scope fixes --base 1a2b3c4", "fleet proof review --lens fresh-eyes --lens correctness --lens design --knowledge correctness=incidents.md", "fleet proof review --wait"],
    options: ["--scope", "--base", "--phase", "--override", "--thread", "--standing", "--round"], repeatable: ["--lens", "--knowledge"], flags: ["--wait"],
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
kind: the gate then ignores that kind's evidence, and the judge does not see it. Kind ci records that CI cannot run on HEAD, such as on a fork PR.
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
    summary: `Check the owed proofs, the review and the answers to its findings, and the CI of the commit on GitHub, then let
the judge weigh them. Exit 0 only on a pass: 1 means the owed proofs are not recorded, a proof is missing, the commit
is not reviewed, a finding has no answer, the commit is not the PR's head on GitHub, its checks are red or pending,
or the judge failed or was unavailable; 3 means only unaccepted gaps remain. No gap waives the head check. The last
line is the verdict and names what it covered. A clean merge of the PR's base carries the review and the evidence of
its other parent forward.
When those checks pass, the judge runs read-only on the reviewer's row of the model table, as fleet proof review
picks it. fleet hands it the diff from the merge base, CI, the owed kinds, the counted evidence, every review's
findings and responses, and the coding standards in ~/.agents/guides/coding-standards.md. It answers four questions:
does the evidence prove HEAD, do the owed kinds fit the diff, does the review hold, and how good is the code. A failed
question or a high quality finding fails the gate; medium and low findings are listed. The verdict is cached per set
of inputs. From the third failing verdict on a PR, the arbiter may escalate to the user; a judge gap on HEAD (gap
--kind judge) lets the gate pass once their standing rule covers it, or once they choose "Accept the gap" in your
question tool for the question that the gate prints. A refusal or a typed message never accepts it. The setting
pull-requests.reviewTimeoutMinutes limits the judge. FLEET_PROOF_JUDGE replaces its command, and
FLEET_PROOF_JUDGE_MODEL its model.`,
    examples: ["fleet proof gate", "fleet proof gate --landed"], flags: ["--landed"],
    run: async ({ flags }, identity, context) => {
      const { print, home, run, now } = context;
      const head = identity();
      const gate = await proofGate(home, head, { landed: flags.has("--landed"), cleanBaseMerge: cleanBaseMerge(head, run), ci: () => ciOf(head, run), pushedHead: () => pushedHeadOf(head, run), now: now?.() });
      for (const line of gate.lines) print(line);
      const judged = gate.code === 0 ? await judgeHead(head, gate, context) : { code: gate.code, lines: [], covered: "" };
      for (const line of judged.lines) print(line);
      print(judged.code === 0 ? `gate: pass (${gate.summary}; judge: ${judged.covered})` : `gate: fail (exit ${judged.code})`);
      return judged.code;
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
      const scope = options.get("--scope") ?? "full";
      context.print(JSON.stringify(await startReview(context.home, head, { scope, base, from: rangeStart(scope, base, head, context.run), ...decisionOf(options, context), phase: options.get("--phase"), cleanBaseMerge: cleanBaseMerge(head, context.run) })));
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
  if (pending && await readPlan(pending.directory)) throw new Error(`${pending.directory} is an unfinished panel. Rerun it with the same fleet proof review --lens command, or wait for it with --wait`);
  const reserved = pending
    ? { round: pending.reservation.round, id: basename(pending.directory), directory: pending.directory, scope: pending.reservation.scope, from: pending.reservation.from ?? rangeStart(pending.reservation.scope, pending.reservation.base, head, run) }
    : await reserveFleetReview(options, head, context);
  const from = reserved.from!;
  const pr = pullRequestDetails(head, run);
  const rules = reviewRules(changedFilesOf(from, head.commit, run), baseTip(head, run), run);
  const diff = diffOf(from, head.commit, run);
  const diffFile = join(reserved.directory, "diff.patch");
  await writeFile(diffFile, diff, { mode: 0o600 });
  const prompt = reviewPrompt({ scope: reserved.scope, from, commit: head.commit, diff, diffFile, crossFamily: familyOf(row) !== author, title: pr.title, body: pr.body, rubric, references: skillReferences(home), reviewRules: rules });
  const answer = await askModel("reviewer", row, { prompt, cwd: topLevel(run) ?? cwd, readable: [join(home, ".agents/skills"), reserved.directory] }, env, limit);
  const label = reserved.round === "final" ? "The final read" : `Round ${reserved.round}`;
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
  const base = options.has("--base") ? resolveCommit(options.get("--base")!, context.run) : undefined;
  const from = rangeStart(scope, base, head, context.run);
  const reserved = await startReview(context.home, head, { scope, base, from, ...decisionOf(options, context), phase: options.get("--phase"), cleanBaseMerge: cleanBaseMerge(head, context.run), capturedBy: "fleet" });
  return { ...reserved, scope, from };
}

const rangeStart = (scope: string, base: string | undefined, head: ProofIdentity, run: Run) => scope === "full" ? mergeBase(head, run) : base;

const waitPolls = 108;
const pollInterval = 5_000;
const proofEntry = resolve(import.meta.dir, "../commands/proof.ts");

const reviewLimit = (env: Record<string, string | undefined>) => numberSetting("pull-requests.reviewTimeoutMinutes", env) * 60_000;

const panelIO = ({ home, env, now, pause }: CommandContext): PanelIO => ({
  env, now: now ?? (() => new Date()), pause: pause ?? (() => Bun.sleep(pollInterval)), slots: join(ledgerRoot(home), ".panel-slots"),
  slotCount: numberSetting("pull-requests.panelSlots", env), pid: process.pid, limit: reviewLimit(env),
});

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
  const pending = await unfinishedFleetReview(home, head);
  const directory = pending ? await rerunPanel(pending.directory, lenses, context) : await reservePanel(options, head, lenses, guide, context);
  const round = (await readJson<{ round: number | "final" }>(join(directory, "round.json"), { round: 0 })).round;
  print(JSON.stringify({ round, directory, lenses: lenses.map(({ name, family }) => ({ name, family })) }));
  print("The lenses run in the background. Run fleet proof review --wait for the findings, and fleet proof show to see each lens.");
  return 0;
}

const castOf = ({ family, row }: Lens, env: Record<string, string | undefined>) => ({ family, row, model: modelLabel("reviewer", row, env) });

async function reservePanel(options: Map<string, string>, head: ProofIdentity, lenses: Lens[], guide: PanelGuide, context: CommandContext) {
  const { home, cwd, env, run } = context;
  const rubric = await readRubric(home);
  const reserved = await reserveFleetReview(options, head, context);
  const from = reserved.from!;
  const pr = pullRequestDetails(head, run);
  const owed = await readOwed(home, head);
  const settled = (await reviewRecords(home, head)).filter((review) => review.responses).map((review) => `${review.label}:\n${review.responses!.trim()}`).join("\n\n");
  const diff = diffOf(from, head.commit, run);
  const diffFile = join(reserved.directory, "diff.patch");
  await writeFile(diffFile, diff, { mode: 0o600 });
  const input = {
    title: pr.title, body: pr.body, base: pr.baseRefName, from, commit: head.commit, diff, diffFile, settled,
    owed: owed?.none ? `none (${owed.none.reason})` : owed?.kinds.join(", ") || "none recorded", rubric,
  };
  const changedFiles = changedFilesOf(from, head.commit, run);
  const rules = reviewRules(changedFiles, baseTip(head, run), run);
  const briefed = lenses.map((lens) => ({ ...lens, knowledge: [rules, lens.knowledge].filter(Boolean).join("\n\n") }));
  const plan = {
    lenses: lenses.map((lens) => ({ name: lens.name, title: lens.title, ...castOf(lens, env) })),
    changedFiles, from, cwd: topLevel(run) ?? cwd, readable: [join(home, ".agents/skills"), reserved.directory],
  };
  await planPanel(reserved.directory, plan, new Map(briefed.map((lens) => [lens.name, lensBrief(guide, lens, input)])));
  for (const lens of lenses) await startLens(reserved.directory, lens.name, context);
  return reserved.directory;
}

async function rerunPanel(directory: string, lenses: Lens[], context: CommandContext) {
  const plan = await readPlan(directory);
  if (!plan) throw new Error(`${directory} is reserved for one reviewer. Run fleet proof review without --lens to retry it`);
  const planned = plan.lenses.map((lens) => lens.name);
  if (lenses.map((lens) => lens.name).sort().join() !== [...planned].sort().join()) throw new Error(`The unfinished round runs the lenses ${planned.join(", ")}. Pass the same --lens set to rerun its failed lenses`);
  const casts = new Map(lenses.map((lens) => [lens.name, castOf(lens, context.env)]));
  for (const name of await requeueFailed(directory, casts)) await startLens(directory, name, context);
  return directory;
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
  const directory = options.has("--round") ? await reviewDirectory(context.home, head, roundOption(options)) : (await unfinishedFleetReview(context.home, head))?.directory ?? await reviewDirectory(context.home, head);
  const code = await waitForPanel(directory, panelIO(context), (name) => startLens(directory, name, context), waitPolls);
  for (const line of await roundLines(directory, context)) context.print(line);
  if (code === 0) context.print(await readFile(join(directory, "findings.md"), "utf8"));
  if (code === 1) context.print("A lens failed, and the round stays unfinished. Run the same fleet proof review --lens command to rerun the failed lenses.");
  if (code === 2) context.print("Lenses still run. Run fleet proof review --wait again.");
  return code;
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
    review: async (miss, prompt, cwd, readable) => askModel("reviewer", (await reviewerOf(miss)).row, { prompt, cwd, readable: [join(home, ".agents/skills"), readable] }, env, reviewLimitMs),
    judge: (prompt) => askModel("eval-judge", judgeRow, { prompt, cwd: tmpdir() }, env, evalJudgeLimit),
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

type Gate = Awaited<ReturnType<typeof proofGate>>;

async function judgeHead(head: ProofIdentity, gate: Gate, context: CommandContext) {
  const { home, cwd, env, run, now } = context;
  const author = await authorOf(home, head);
  const row = reviewerRow(author, env);
  const limit = reviewLimit(env);
  const from = mergeBase(head, run);
  const input = {
    cwd: topLevel(run) ?? cwd, from, commit: head.commit, diff: diffOf(from, head.commit, run), crossFamily: familyOf(row) !== author, ci: gate.ci, owed: gate.owed!, ledger: gate.lines,
    evidence: gate.evidence, reviews: await reviewRecords(home, head), rubric: await readRubric(home), references: skillReferences(home),
  };
  const today = now?.() ?? new Date();
  const outcome = await judge(input, {
    ask: (request) => askModel("judge", row, request, env, limit), model: modelLabel("judge", row, env), arbiter: arbiterOf(context),
    directory: judgeDirectory(home, head), commit: head.commit, now: today,
  });
  if (outcome.state === "pass") return { code: 0, lines: outcome.lines, covered: `pass by ${outcome.model}` };
  const gap = await judgeGap(home, head, today);
  if (gap?.acceptance) return { code: 0, lines: [...outcome.lines, `judge gap: ${gap.acceptance.line}: ${gap.reason}`], covered: `${outcome.state} accepted by ${gap.acceptance.by}` };
  if (gap) return { code: 3, lines: [...outcome.lines, `judge gap: not accepted: ${gap.reason}. ${askGap(head, "judge", gap.reason)}`], covered: "" };
  const standing = await standingFor(home, "judge", today);
  const hint = standing ? [`judge gap: the user's standing rule accepts a judge gap on HEAD until ${standing.until}. Record it with fleet proof gap --kind judge --reason <why the judge is wrong>`] : [];
  return { code: 1, lines: [...outcome.lines, ...hint], covered: "" };
}

async function roundLines(directory: string, { now }: CommandContext) {
  const round = await readJson<{ round: number | "final"; commit: string; reviewer?: string; capturedBy?: string; standing?: { reason: string; until: string } } | undefined>(join(directory, "round.json"), undefined);
  if (!round) throw new Error(`${directory} has no reservation`);
  const finished = round.reviewer ? `finished by ${round.reviewer}, ${round.capturedBy === "fleet" ? "captured by fleet" : "saved by the author"}: ${join(directory, "findings.md")}` : "reserved, no findings yet";
  const header = `${round.round === "final" ? "final read" : `round ${round.round}`} on ${short(round.commit)}: ${finished}`;
  const anchors = join(directory, "anchors.md");
  const standing = round.standing ? [`accepted by the standing rule until ${round.standing.until}: ${round.standing.reason}`] : [];
  return [header, ...(existsSync(anchors) ? [`anchor check by fleet: ${anchors}`] : []), ...standing, ...(await readPlan(directory) ? await panelLines(directory, now?.() ?? new Date()) : [])];
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

function hearing(options: Map<string, string>, { home, threadWords }: CommandContext) {
  const thread = options.get("--thread");
  return thread === undefined ? withoutThread : listenIn(thread, threadWords ?? t3ThreadWords(home));
}

const t3ThreadWords = (home: string): ThreadWords => (thread) =>
  withT3Session((client) => readThreadWords(client, thread, t3StatePath(t3UserData(home))), { home })
    .catch((error: Error) => { throw new Error(`Cannot read T3 thread ${thread} (${error.message})`); });

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
  const lines = Object.values(subcommands).filter((command) => !command.hidden).map((command) => `  fleet proof ${command.usage}`);
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
