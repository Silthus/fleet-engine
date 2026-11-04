import { join, resolve } from "node:path";
import { finishReview, listStanding, parseVerdict, proofDirectory, proofGate, readJson, recordGap, recordStanding, requireNone, requireProofs, respondToReview, reuseProof, reviewDirectory, saveProof, startReview, type Arbiter, type CiResult, type CleanBaseMerge, type ProofIdentity } from "./proof.ts";
import { askModel, family, sessionFamily, type Family } from "./proof-models.ts";
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
reads that thread, and the quoted words must appear in a message the user typed there or in the answer they gave to a
question tool in the T3 app; an answer sent through MCP does not count. The ledger keeps the thread, the message, the
user's words, and the question they answered.`;

const overrideHelp = `--override takes the user's answer to this round or finding: their words in quotes and the date they gave them,
for example --override '2026-10-24 "Run round 7; the new findings are real."' --thread <T3 thread id>. A general
rule, such as "ship everything autonomously", does not answer a specific round.
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
  show: {
    usage: "show [--round <number|final>]",
    summary: "Print the latest review round, or --round: who reviewed it and where its findings are.",
    examples: ["fleet proof show", "fleet proof show --round 2"],
    options: ["--round"],
    run: async ({ options }, identity, context) => {
      const directory = await reviewDirectory(context.home, identity(), roundOption(options));
      for (const line of await roundLines(directory)) context.print(line);
      return 0;
    },
  },
  respond: {
    usage: "respond --round <number|final> <responses.md>",
    summary: `Save your answer to each finding of a finished review: fixed in which commit, or rejected and why. A new call
replaces the earlier answer.`,
    examples: ["fleet proof respond --round 1 responses.md", "fleet proof respond --round final responses.md"],
    options: ["--round"],
    run: async ({ options, files }, identity, { print, home, cwd }) => {
      if (files.length !== 1) throw usageError("respond", "Pass one responses file");
      const round = required(options, "--round", "respond");
      print(await respondToReview(home, identity(), round === "final" ? "final" : Number(round), resolve(cwd, files[0]!)));
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
    summary: `Record why an owed proof could not run, or the user's acceptance of that gap. --accept takes their answer to
this gap, with their words in quotes. It refuses a quote of the user's instructions, which a standing rule covers, and
an answer already recorded on another PR or round. Their acceptance settles the kind: the gate then ignores that
kind's evidence. Kind ci records that CI cannot run on HEAD, such as on a fork PR.
${answerHelp}`,
    examples: ["fleet proof gap --kind prod-shape --reason 'No production read access'", `fleet proof gap --kind prod-shape --accept '2026-10-25 "Accept the gap"' --thread mcp:1a2b`],
    options: ["--kind", "--reason", "--accept", "--thread"],
    run: async ({ options }, identity, context) => {
      const kind = required(options, "--kind", "gap");
      const [reason, accept] = [options.get("--reason"), options.get("--accept")];
      if ((reason === undefined) === (accept === undefined)) throw usageError("gap", "Pass either --reason or --accept");
      const update = reason === undefined ? { accept: accept!, hear: hearing(options, context) } : { reason };
      context.print(JSON.stringify(await recordGap(context.home, identity(), kind, update)));
      return 0;
    },
  },
  gate: {
    usage: "gate [--landed]",
    summary: `Check the owed proofs, the review, and the CI of the commit on GitHub. Exit 0 only on a pass: 1 means the owed
proofs are not recorded, a proof is missing, the commit is not reviewed, or CI is red, pending, or not on the pushed
head; 3 means only unaccepted gaps remain. The last line is the verdict and names what it covered. A clean merge of
the PR's base carries the review and the evidence of its other parent forward.`,
    examples: ["fleet proof gate", "fleet proof gate --landed"], flags: ["--landed"],
    run: async ({ flags }, identity, { print, home, run, now }) => {
      const head = identity();
      const gate = await proofGate(home, head, { landed: flags.has("--landed"), cleanBaseMerge: cleanBaseMerge(head, run), ci: () => ciOf(head, run), now: now?.() });
      for (const line of gate.lines) print(line);
      print(gate.code === 0 ? `gate: pass (${gate.summary})` : `gate: fail (exit ${gate.code})`);
      return gate.code;
    },
  },
  "review-start": {
    usage: "review-start [--scope full|fixes|final] [--base <reviewed-sha>] [--phase review|babysit] [--override <dated quote> --thread <id> | --standing <reason>]",
    summary: `Reserve a review round before you dispatch its reviewers. Round 1 is --scope full. A later round is
--scope fixes, and a final read is --scope final; both take --base with the commit of the latest finished review.
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
    usage: "review-finish --round <number|final> --reviewer <model> <findings.md>",
    summary: `Save the findings of a reserved round after its reviewers finish. --reviewer names the model that wrote them;
the gate prints it. The findings file must not be empty; write "No findings." when the reviewer found none.`,
    examples: ["fleet proof review-finish --round 1 --reviewer gpt-6.1-sol findings.md", "fleet proof review-finish --round final --reviewer claude-opus-5-5 findings.md"],
    options: ["--round", "--findings", "--reviewer"],
    run: async ({ options, files }, identity, { print, home, cwd }) => {
      const findings = options.has("--findings") ? [options.get("--findings")!, ...files] : files;
      if (findings.length !== 1) throw usageError("review-finish", "Pass one findings file");
      const round = required(options, "--round", "review-finish");
      const reviewer = required(options, "--reviewer", "review-finish");
      print(await finishReview(home, identity(), round === "final" ? "final" : Number(round), resolve(cwd, findings[0]!), reviewer));
      return 0;
    },
  },
};

async function roundLines(directory: string) {
  const round = await readJson<{ round: number | "final"; commit: string; reviewer?: string; capturedBy?: string; standing?: { reason: string; until: string } } | undefined>(join(directory, "round.json"), undefined);
  if (!round) throw new Error(`${directory} has no reservation`);
  const finished = round.reviewer ? `finished by ${round.reviewer}, ${round.capturedBy === "fleet" ? "captured by fleet" : "saved by the author"}: ${join(directory, "findings.md")}` : "reserved, no findings yet";
  const header = `${round.round === "final" ? "final read" : `round ${round.round}`} on ${short(round.commit)}: ${finished}`;
  return [header, ...(round.standing ? [`accepted by the standing rule until ${round.standing.until}: ${round.standing.reason}`] : [])];
}

function roundOption(options: Map<string, string>) {
  const round = options.get("--round");
  return round === undefined ? undefined : round === "final" ? "final" : Number(round);
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

type Check = { name: string; bucket: string };

function ciOf(identity: ProofIdentity, run: Run): CiResult {
  const view = run(["gh", "pr", "view", String(identity.pr), "--repo", identity.repository, "--json", "headRefOid"]);
  if (view.code !== 0) return { state: "unknown", detail: `cannot read the PR head with gh (${firstLine(view.stderr)})` };
  const head = (JSON.parse(view.stdout) as { headRefOid?: string }).headRefOid ?? "";
  if (head !== identity.commit) return { state: "pending", detail: `${short(identity.commit)} is not the PR's head on GitHub (${short(head) || "none"}); push it` };
  const result = run(["gh", "pr", "checks", String(identity.pr), "--repo", identity.repository, "--json", "name,bucket"]);
  let checks: Check[] | undefined;
  try { checks = JSON.parse(result.stdout) as Check[]; } catch {}
  if (!checks) return /no checks reported/i.test(result.stderr) ? { state: "none", detail: "no checks reported" } : { state: "unknown", detail: `gh pr checks failed (${firstLine(result.stderr)})` };
  if (!checks.length) return { state: "none", detail: "no checks reported" };
  const named = (buckets: string[]) => checks.filter((check) => buckets.includes(check.bucket)).map((check) => check.name);
  const [failing, pending] = [named(["fail", "cancel"]), named(["pending"])];
  if (failing.length) return { state: "red", detail: `failing: ${failing.join(", ")}` };
  if (pending.length) return { state: "pending", detail: `waiting on: ${pending.join(", ")}` };
  return { state: "green", detail: `${checks.length} check(s)` };
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
