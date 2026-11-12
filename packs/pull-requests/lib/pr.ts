import { join } from "node:path";
import { runGh } from "./gh.ts";
import { parseBlockerArgs, prBlockers } from "./pr-blockers.ts";
import { recordHandover } from "./pr-owners.ts";
import { botThreads, parsePrArgs } from "./pr-threads.ts";
import { askReviewBot, parseReviewBotArgs } from "./review-bot.ts";

export const help = `fleet pr: review threads, blockers, review bots, and handovers of a pull request

  fleet pr bot-threads --repo <owner/repo> --pr <number> [--resolve] [--fixed <thread URL>]...
                     List a PR's unresolved review threads as bot or human; a 👍 from you answers one.
                     --resolve resolves answered bot threads; --fixed resolves the named bot threads a push fixed.
                     Neither ever resolves a thread a person opened
  fleet pr blockers --repo <owner/repo> --pr <number> [--record]
                     List what blocks a PR; with --record, exit 3 when a fix left the same blockers
  fleet pr review --repo <owner/repo> --pr <number> [--deep] [--minutes <n>]
                     Ask the review bot to review the PR's head and print its findings; exit 1 on findings, 2 without a bot
  fleet pr stamp --repo <owner/repo> --pr <number> [--minutes <n>]
                     Ask the review bot to approve the PR and print its verdict; exit 0 only when it approved, 2 without a bot
  fleet pr forecast --repo <owner/repo> --pr <number> [--request]
                     Ask the review bot whether it will likely refuse the PR and who owns it; with --request, request those owners; 2 without a bot
  fleet pr handover --pr <PR URL> --to <thread id>
                     Record that another thread took over the PR, so this thread may settle; that thread links the PR`;

export async function prCommand(args: string[], home: string, now = new Date()): Promise<number> {
  if (args[0] === "help" || args[0] === "--help") return console.log(help), 0;
  if (args[0] === "handover") return console.log(JSON.stringify(await recordHandover(args.slice(1), home, process.env.T3CODE_THREAD_ID, now))), 0;
  if (args[0] === "review" || args[0] === "stamp" || args[0] === "forecast") return askReviewBot(parseReviewBotArgs(args[0], args.slice(1)));
  const report = args[0] === "blockers"
    ? await prBlockers(parseBlockerArgs(args.slice(1)), runGh, join(home, ".local/state/fleet/pr-blockers"), new Date())
    : await botThreads(parsePrArgs(args), runGh);
  console.log(report.output);
  return report.exitCode;
}
