import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { prCommand } from "./pr.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const command = join(import.meta.dir, "..", "commands", "pr.ts");
const head1 = "aaaaaaaaaaaa1111111111111111111111111111";
const head2 = "bbbbbbbbbbbb2222222222222222222222222222";

function sandbox() {
  const root = temp.make("fleet-pr-");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const replies = join(root, "replies");
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(replies);
  const log = join(root, "gh.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" | tr '\\n' ' ' >> "${log}"
echo >> "${log}"
after=$(printf '%s\n' "$@" | sed -n 's/^after=//p')
id=$(printf '%s\n' "$@" | sed -n 's/^id=//p')
case "$*" in
  *resolveReviewThread*) reply=resolve ;;
  *PullRequestReviewThread*) reply="comments-$id-\${after:-first}" ;;
  "api graphql"*) reply="threads\${after:+-$after}" ;;
  "pr view"*) reply=pr ;;
  *) echo "unexpected gh call" >&2; exit 9 ;;
esac
[ -f "${replies}/$reply.json" ] || { echo "no $reply reply" >&2; exit 1; }
cat "${replies}/$reply.json"
`);
  chmodSync(join(bin, "gh"), 0o755);
  const reply = (name: string, value: unknown) => writeFileSync(join(replies, `${name}.json`), JSON.stringify(value));
  const env: Record<string, string> = { FLEET_HANDLERS: "{}", FLEET_SETTINGS: "{}" };
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, command, ...args], { cwd: root, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env } });
    return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
  };
  const call = async (...args: string[]) => {
    const printed: string[] = [];
    const warned: string[] = [];
    const print = spyOn(console, "log").mockImplementation((...line: unknown[]) => void printed.push(line.join(" ")));
    const warn = spyOn(console, "error").mockImplementation((...line: unknown[]) => void warned.push(line.join(" ")));
    const saved = { FLEET_HANDLERS: process.env.FLEET_HANDLERS, FLEET_SETTINGS: process.env.FLEET_SETTINGS };
    Object.assign(process.env, env);
    try {
      return { code: await prCommand(args, home), out: printed.join("\n").trim(), err: warned.join("\n").trim() };
    } finally {
      print.mockRestore();
      warn.mockRestore();
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  const refusal = async (...args: string[]) => {
    try {
      await call(...args);
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const reviewBot = (exitCode: number) => {
    const path = join(root, "review-bot.ts");
    writeFileSync(path, `await Bun.write(${JSON.stringify(join(root, "bot-args.json"))}, JSON.stringify(Bun.argv.slice(2)));\nconsole.log("bot says hi");\nprocess.exit(${exitCode});\n`);
    env.FLEET_HANDLERS = JSON.stringify({ "review-bot": path });
  };
  const botArgs = () => JSON.parse(readFileSync(join(root, "bot-args.json"), "utf8"));
  return { home, env, reply, run, call, refusal, calls, reviewBot, botArgs };
}

const user = (login: string) => ({ __typename: "User", login });
const bot = (login: string) => ({ __typename: "Bot", login });
const comment = (author: unknown, url: string) => ({ author, url });
const page = (nodes: unknown[], next?: string) => ({ nodes, pageInfo: { hasNextPage: Boolean(next), endCursor: next ?? null } });
const thread = (id: string, path: string, line: number | null, comments: unknown[], isResolved = false, moreComments?: string) =>
  ({ id, isResolved, path, line, originalLine: line ?? 7, comments: page(comments, moreComments) });
const threads = (viewer: string, nodes: unknown[], next?: string) => ({ data: { viewer: { login: viewer }, repository: { pullRequest: { reviewThreads: page(nodes, next) } } } });
const comments = (nodes: unknown[], next?: string) => ({ data: { node: { comments: page(nodes, next) } } });

const reviewThreads = threads("me", [
  thread("T1", "src/a.ts", 3, [comment(bot("coderabbitai"), "https://example.test/1")]),
  thread("T2", "src/b.ts", null, [comment(bot("greptile-apps"), "https://example.test/2"), comment(user("me"), "https://example.test/2r")]),
  thread("T3", "src/c.ts", 9, [comment(user("reviewer"), "https://example.test/3")]),
  thread("T4", "src/d.ts", 1, [comment(user("renovate"), "https://example.test/4")]),
  thread("T5", "src/e.ts", 2, [comment(bot("codecov"), "https://example.test/5")], true),
]);

test("bot-threads sorts unresolved threads into bot and human, answered or not, and fails while a bot thread waits", () => {
  const box = sandbox();
  box.reply("threads", reviewThreads);
  const result = box.run("bot-threads", "--repo", "acme/widgets", "--pr", "12");
  expect(result.out).toBe([
    "bot unanswered src/a.ts:3 https://example.test/1",
    "bot answered src/b.ts:7 https://example.test/2",
    "human unanswered src/c.ts:9 https://example.test/3",
    "bot unanswered src/d.ts:1 https://example.test/4",
    "2 unanswered bot threads remain.",
  ].join("\n"));
  expect(result.code).toBe(1);
  expect(box.calls()).toHaveLength(1);
  expect(box.calls()[0]).toEndWith("-f owner=acme -f repo=widgets -F number=12");
});

test("bot-threads --resolve resolves only the answered bot threads", () => {
  const box = sandbox();
  box.reply("threads", threads("me", [
    thread("T2", "src/b.ts", 4, [comment(bot("greptile-apps"), "https://example.test/2"), comment(user("me"), "https://example.test/2r")]),
    thread("T3", "src/c.ts", 9, [comment(user("reviewer"), "https://example.test/3"), comment(user("me"), "https://example.test/3r")]),
  ]));
  box.reply("resolve", { data: {} });
  const result = box.run("bot-threads", "--repo", "acme/widgets", "--pr", "12", "--resolve");
  expect(result.out).toBe([
    "bot answered src/b.ts:4 https://example.test/2",
    "human answered src/c.ts:9 https://example.test/3",
    "resolved src/b.ts:4 https://example.test/2",
  ].join("\n"));
  expect(result.code).toBe(0);
  const resolves = box.calls().filter((call) => call.includes("resolveReviewThread"));
  expect(resolves).toHaveLength(1);
  expect(resolves[0]).toContain("id=T2");
});

test("bot-threads --resolve never resolves a thread a person opened, even when only bots answered it", () => {
  const box = sandbox();
  box.reply("threads", threads("me", [
    thread("T6", "src/f.ts", 5, [comment(user("me"), "https://example.test/6"), comment(bot("coderabbitai"), "https://example.test/6b"), comment(user("me"), "https://example.test/6r")]),
    thread("T7", "src/g.ts", 6, [comment(bot("coderabbitai"), "https://example.test/7")]),
  ]));
  box.reply("resolve", { data: {} });
  const result = box.run("bot-threads", "--repo", "acme/widgets", "--pr", "12", "--resolve");
  expect(result.out).toBe(["human answered src/f.ts:5 https://example.test/6", "bot unanswered src/g.ts:6 https://example.test/7", "1 unanswered bot thread remains."].join("\n"));
  expect(box.calls().filter((call) => call.includes("resolveReviewThread"))).toEqual([]);
});

test("bot-threads reads every page of threads and of each thread's comments", () => {
  const box = sandbox();
  const resolved = Array.from({ length: 100 }, (_, index) => thread(`R${index}`, "src/old.ts", index, [comment(bot("codecov"), `https://example.test/r${index}`)], true));
  box.reply("threads", threads("me", resolved, "page2"));
  box.reply("threads-page2", threads("me", [thread("T8", "src/h.ts", 8, [comment(bot("greptile-apps"), "https://example.test/8"), comment(user("me"), "https://example.test/8r")], false, "c2")]));
  box.reply("comments-T8-c2", comments([comment(bot("greptile-apps"), "https://example.test/8f")]));
  box.reply("resolve", { data: {} });
  const result = box.run("bot-threads", "--repo", "acme/widgets", "--pr", "12", "--resolve");
  expect(result.out).toBe(["bot unanswered src/h.ts:8 https://example.test/8", "1 unanswered bot thread remains."].join("\n"));
  expect(result.code).toBe(1);
  expect(box.calls().filter((call) => call.includes("resolveReviewThread"))).toEqual([]);
});

test("bot-threads says so when no thread is open", () => {
  const box = sandbox();
  box.reply("threads", threads("me", [thread("T5", "src/e.ts", 2, [comment(bot("codecov"), "https://example.test/5")], true)]));
  expect(box.run("bot-threads", "--repo", "acme/widgets", "--pr", "12")).toEqual({ code: 0, out: "No unresolved review threads.", err: "" });
});

test("bot-threads names a pull request that does not exist", () => {
  const box = sandbox();
  box.reply("threads", { data: { viewer: { login: "me" }, repository: { pullRequest: null } } });
  const result = box.run("bot-threads", "--repo", "acme/widgets", "--pr", "404");
  expect(result.code).toBe(1);
  expect(result.err).toBe("fleet pr: No pull request acme/widgets#404");
});

test("a failing gh call surfaces its error", () => {
  const box = sandbox();
  const result = box.run("blockers", "--repo", "acme/widgets", "--pr", "12");
  expect(result.code).toBe(1);
  expect(result.err).toBe("fleet pr: gh pr failed: no pr reply");
});

const pr = (head: string, fields: Record<string, unknown> = {}) => ({ headRefOid: head, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", statusCheckRollup: [], ...fields });
const run = (name: string, status: string, conclusion: string | null) => ({ __typename: "CheckRun", name, status, conclusion });

test("blockers waits while checks run or mergeability is unknown", () => {
  const box = sandbox();
  box.reply("pr", pr(head1, { mergeable: "UNKNOWN", statusCheckRollup: [run("lint", "IN_PROGRESS", null), { __typename: "StatusContext", context: "deploy", state: "PENDING" }] }));
  const result = box.run("blockers", "--repo", "acme/widgets", "--pr", "12");
  expect(result.out).toBe(["head: aaaaaaaaaaaa", "pending: deploy", "pending: lint", "Not settled yet: wait for the checks and GitHub's mergeability, then run it again."].join("\n"));
  expect(result.code).toBe(2);
  expect(box.calls()[0]).toBe("pr view 12 --repo acme/widgets --json headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup");
});

test("blockers passes when only people and a moved base hold the PR", () => {
  const box = sandbox();
  box.reply("pr", pr(head1, { mergeStateStatus: "BEHIND", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [run("lint", "COMPLETED", "FAILURE"), run("lint", "COMPLETED", "SUCCESS"), run("deploy", "COMPLETED", "ACTION_REQUIRED")] }));
  const result = box.run("blockers", "--repo", "acme/widgets", "--pr", "12");
  expect(result.out).toBe([
    "head: aaaaaaaaaaaa",
    "behind: the base moved; update the branch when the repo requires it",
    "waits on people: review required",
    "waits on people: deploy waits for approval",
    "Nothing an agent can fix blocks the PR.",
  ].join("\n"));
  expect(result.code).toBe(0);
});

test("blockers keeps a failing check that shares its name with a passing check of another workflow, and takes the latest retry", () => {
  const box = sandbox();
  const job = (workflowName: string, conclusion: string, startedAt: string) => ({ ...run("test", "COMPLETED", conclusion), workflowName, startedAt });
  box.reply("pr", pr(head1, { statusCheckRollup: [job("unit", "FAILURE", "2026-11-04T10:00:00Z"), job("e2e", "SUCCESS", "2026-11-04T10:00:00Z"), job("e2e", "FAILURE", "2026-11-04T09:00:00Z")] }));
  const result = box.run("blockers", "--repo", "acme/widgets", "--pr", "12");
  expect(result.out).toBe(["head: aaaaaaaaaaaa", "failing: unit / test", "signature: failing:unit / test"].join("\n"));
  expect(result.code).toBe(1);
});

test("blockers lists failing checks and a conflict with their signature", () => {
  const box = sandbox();
  box.reply("pr", pr(head1, { isDraft: true, mergeable: "CONFLICTING", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [run("test", "COMPLETED", "TIMED_OUT"), { __typename: "StatusContext", context: "build", state: "ERROR" }] }));
  const result = box.run("blockers", "--repo", "acme/widgets", "--pr", "12");
  expect(result.out).toBe(["head: aaaaaaaaaaaa", "failing: build", "failing: test", "conflict: the branch conflicts with its base", "signature: conflict|failing:build|failing:test"].join("\n"));
  expect(result.code).toBe(1);
  expect(existsSync(join(box.home, ".local/state/fleet/pr-blockers"))).toBe(false);
});

test("blockers --record exits 3 when a new head still has the same blockers", () => {
  const box = sandbox();
  const failing = { statusCheckRollup: [run("test", "COMPLETED", "FAILURE")] };
  box.reply("pr", pr(head1, failing));
  expect(box.run("blockers", "--repo", "acme/widgets", "--pr", "12", "--record").code).toBe(1);
  expect(box.run("blockers", "--repo", "acme/widgets", "--pr", "12", "--record").code).toBe(1);
  box.reply("pr", pr(head2, failing));
  const result = box.run("blockers", "--repo", "acme/widgets", "--pr", "12", "--record");
  expect(result.out).toBe([
    "head: bbbbbbbbbbbb",
    "failing: test",
    "signature: failing:test",
    "No progress: the same blockers stood at aaaaaaaaaaaa before the last fix. Read the failing log: a new cause under the same check is progress; the same cause is a question for the user.",
  ].join("\n"));
  expect(result.code).toBe(3);
  const ledger = readFileSync(join(box.home, ".local/state/fleet/pr-blockers/acme/widgets/12.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(ledger.map((record) => [record.head, record.signature])).toEqual([[head1, "failing:test"], [head1, "failing:test"], [head2, "failing:test"]]);
});

test("review hands its parsed arguments to the review-bot handler and exits with the handler's code", () => {
  const box = sandbox();
  box.reviewBot(1);
  const result = box.run("review", "--pr", "12", "--deep", "--repo", "acme/widgets");
  expect(box.botArgs()).toEqual(["review", "--repo", "acme/widgets", "--pr", "12", "--minutes", "15", "--deep"]);
  expect(result.out).toBe("bot says hi");
  expect(result.code).toBe(1);
});

test("stamp hands its parsed arguments to the review-bot handler", () => {
  const box = sandbox();
  box.reviewBot(0);
  const result = box.run("stamp", "--repo", "acme/widgets", "--pr", "12", "--minutes", "5");
  expect(box.botArgs()).toEqual(["stamp", "--repo", "acme/widgets", "--pr", "12", "--minutes", "5"]);
  expect(result.code).toBe(0);
});

test("forecast hands its parsed arguments to the review-bot handler and exits with the handler's code", () => {
  const box = sandbox();
  box.reviewBot(7);
  const result = box.run("forecast", "--pr", "12", "--request", "--repo", "acme/widgets");
  expect(box.botArgs()).toEqual(["forecast", "--repo", "acme/widgets", "--pr", "12", "--request"]);
  expect(result).toEqual({ code: 7, out: "bot says hi", err: "" });
  box.run("forecast", "--repo", "acme/widgets", "--pr", "12");
  expect(box.botArgs()).toEqual(["forecast", "--repo", "acme/widgets", "--pr", "12"]);
});

test("forecast refuses review and stamp flags, and says there is nothing to forecast without a review bot", async () => {
  const box = sandbox();
  box.reviewBot(0);
  for (const args of [["forecast", "--minutes", "5"], ["forecast", "--deep"], ["review", "--request"], ["stamp", "--request"]]) {
    const refused = await box.refusal(args[0]!, "--repo", "acme/widgets", "--pr", "12", ...args.slice(1));
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("Usage: fleet pr");
  }
  expect(existsSync(join(box.home, "..", "bot-args.json"))).toBe(false);
  box.env.FLEET_HANDLERS = "{}";
  expect(await box.call("forecast", "--repo", "acme/widgets", "--pr", "12")).toEqual({ code: 2, out: "No review bot is on for this machine, so there is no forecast. Ask for a review the way the repo's docs say.", err: "" });
});

test("without a review-bot handler, review and stamp print the fallback the settings name and exit 2", async () => {
  const box = sandbox();
  box.env.FLEET_SETTINGS = JSON.stringify({ "pull-requests.reviewFallback": "Comment `review please` on {repo}#{pr}.", "pull-requests.stampFallback": "Add the `approve-me` label to {repo}#{pr}." });
  expect(await box.call("review", "--repo", "acme/widgets", "--pr", "12")).toEqual({ code: 2, out: "No review bot is on for this machine. Comment `review please` on acme/widgets#12.", err: "" });
  expect(await box.call("stamp", "--repo", "acme/widgets", "--pr", "12")).toEqual({ code: 2, out: "No review bot is on for this machine. Add the `approve-me` label to acme/widgets#12.", err: "" });
  box.env.FLEET_SETTINGS = "{}";
  expect(await box.call("review", "--repo", "acme/widgets", "--pr", "12")).toEqual({ code: 2, out: "No review bot is on for this machine. Ask for a review the way the repo's docs say.", err: "" });
  expect(await box.call("stamp", "--repo", "acme/widgets", "--pr", "12")).toEqual({ code: 2, out: "No review bot is on for this machine. Ask for an approval the way the repo's docs say.", err: "" });
  expect(box.calls()).toEqual([]);
});

test("run outside fleet, review and stamp still print the default fallback and exit 2", () => {
  const box = sandbox();
  delete box.env.FLEET_HANDLERS;
  delete box.env.FLEET_SETTINGS;
  const { FLEET_HANDLERS: _, FLEET_SETTINGS: __, ...inherited } = process.env;
  const result = Bun.spawnSync([process.execPath, command, "review", "--repo", "acme/widgets", "--pr", "12"], { env: { ...inherited, HOME: box.home } });
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString().trim()).toBe("No review bot is on for this machine. Ask for a review the way the repo's docs say.");
});

test("stopping review stops the review-bot handler before review exits", async () => {
  const box = sandbox();
  const stopped = join(box.home, "stopped");
  const handler = join(box.home, "slow-bot.ts");
  writeFileSync(handler, `process.on("SIGTERM", async () => { await Bun.write(${JSON.stringify(stopped)}, "stopped"); process.exit(5); });\nconsole.log("ready");\nsetInterval(() => {}, 1000);\n`);
  const child = Bun.spawn([process.execPath, command, "review", "--repo", "acme/widgets", "--pr", "12"], { env: { ...process.env, HOME: box.home, FLEET_SETTINGS: "{}", FLEET_HANDLERS: JSON.stringify({ "review-bot": handler }) }, stdout: "pipe" });
  try {
    const reader = child.stdout.getReader();
    let seen = "";
    while (!seen.includes("ready")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`review ended before its handler was ready: ${seen}`);
      seen += new TextDecoder().decode(chunk.value);
    }
    child.kill("SIGTERM");
    expect(await child.exited).toBe(5);
    expect(readFileSync(stopped, "utf8")).toBe("stopped");
  } finally {
    child.kill("SIGKILL");
  }
});

test("wrong arguments print the usage and exit 1", async () => {
  const box = sandbox();
  for (const args of [[], ["threads"], ["bot-threads", "--repo", "widgets", "--pr", "1"], ["blockers", "--repo", "acme/widgets"], ["blockers", "--repo", "acme/widgets", "--pr", "x"], ["review", "--repo", "acme/widgets"], ["review", "--repo", "acme/widgets", "--pr", "1", "--minutes", "0"], ["stamp", "--repo", "acme/widgets", "--pr", "1", "--deep"]]) {
    const refused = await box.refusal(...args);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toStartWith("Usage: fleet pr ");
  }
  const cli = box.run("threads");
  expect(cli.code).toBe(1);
  expect(cli.err).toStartWith("fleet pr: Usage: fleet pr ");
  expect(box.calls()).toEqual([]);
});

test("help lists every subcommand", async () => {
  const box = sandbox();
  const result = await box.call("--help");
  expect(result.code).toBe(0);
  expect(result.out).toContain("fleet pr bot-threads --repo <owner/repo> --pr <number> [--resolve]");
  expect(result.out).toContain("fleet pr blockers --repo <owner/repo> --pr <number> [--record]");
  expect(result.out).toContain("fleet pr review --repo <owner/repo> --pr <number> [--deep] [--minutes <n>]");
  expect(result.out).toContain("fleet pr stamp --repo <owner/repo> --pr <number> [--minutes <n>]");
});
