import { join } from "node:path";
import { runGh } from "./gh.ts";
import { parseBlockerArgs, prBlockers } from "./pr-blockers.ts";
import { botThreads, parsePrArgs } from "./pr-threads.ts";
import { askReviewBot, parseReviewBotArgs, runHandler } from "./review-bot.ts";

export const help = `fleet pr: review threads, blockers, and review bots of a pull request

  fleet pr bot-threads --repo <owner/repo> --pr <number> [--resolve]
                     List a PR's unresolved review threads as bot or human; resolve answered bot threads
  fleet pr blockers --repo <owner/repo> --pr <number> [--record]
                     List what blocks a PR; with --record, exit 3 when a fix left the same blockers
  fleet pr review --repo <owner/repo> --pr <number> [--deep] [--minutes <n>]
                     Ask the review bot to review the PR's head and print its findings; exit 1 on findings, 2 without a bot
  fleet pr stamp --repo <owner/repo> --pr <number> [--minutes <n>]
                     Ask the review bot to approve the PR and print its verdict; exit 0 only when it approved, 2 without a bot
  fleet pr forecast --repo <owner/repo> (--pr <number> [--request] | --branch <name> | --paths <file>)
                     Ask the review bot whether it will likely refuse the PR and who owns it; with --request, request those owners;
                     with --branch or --paths, forecast work that has no PR yet; 2 without a bot`;

const engineSubcommands = new Set(["help", "--help", "bot-threads", "blockers", "review", "stamp", "forecast"]);

export async function prCommand(args: string[], home: string, env: Record<string, string | undefined> = Bun.env): Promise<number> {
  const packCommands = (JSON.parse(env.FLEET_HANDLERS || "{}") as Record<string, string>)["pr-command"];
  if (packCommands && !engineSubcommands.has(args[0] ?? "")) return runHandler(["bun", packCommands, ...args], env);
  if (args[0] === "help" || args[0] === "--help") {
    console.log(help);
    return packCommands ? runHandler(["bun", packCommands, "help"], env) : 0;
  }
  if (args[0] === "review" || args[0] === "stamp" || args[0] === "forecast") return askReviewBot(parseReviewBotArgs(args[0], args.slice(1)));
  const report = args[0] === "blockers"
    ? await prBlockers(parseBlockerArgs(args.slice(1)), runGh, join(home, ".local/state/fleet/pr-blockers"), new Date())
    : await botThreads(parsePrArgs(args), runGh);
  console.log(report.output);
  return report.exitCode;
}
