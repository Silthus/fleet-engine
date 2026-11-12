import { join } from "node:path";
import { runGh } from "./gh.ts";
import { parseBlockerArgs, prBlockers } from "./pr-blockers.ts";
import { recordHandover } from "./pr-owners.ts";
import { botThreads, parsePrArgs } from "./pr-threads.ts";
import { askReviewBot, parseReviewBotArgs, runHandler } from "./review-bot.ts";

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
  fleet pr forecast --repo <owner/repo> (--pr <number> [--request] | --branch <name> | --paths <file>)
                     Ask the review bot whether it will likely refuse the PR and who owns it; with --request, request those owners;
                     with --branch or --paths, forecast work that has no PR yet and exit 1 when it needs splitting;
                     2 without a bot, 3 when the bot's forecast fails
  fleet pr handover --pr <PR URL> --to <thread id>
                     Record that another thread took over the PR, so this thread may settle; that thread links the PR`;

const engineSubcommands = ["bot-threads", "blockers", "review", "stamp", "forecast", "handover"];

type Env = Record<string, string | undefined>;

/** The pack that adds fleet pr subcommands: its handler, and the words it declared in its pack.json. Engine words always stay with the engine. */
function packCommands(env: Env): { handler: string; words: string[] } | undefined {
  const handler = (JSON.parse(env.FLEET_HANDLERS || "{}") as Record<string, string>)["pr-command"];
  const declared = (JSON.parse(env.FLEET_HANDLER_SUBCOMMANDS || "{}") as Record<string, string[]>)["pr-command"] ?? [];
  return handler ? { handler, words: declared.filter((word) => !engineSubcommands.includes(word)) } : undefined;
}

export async function prCommand(args: string[], home: string, env: Env = Bun.env, now = new Date()): Promise<number> {
  const pack = packCommands(env);
  const word = args[0] ?? "";
  if (pack && pack.words.includes(word)) return runHandler(["bun", pack.handler, ...args], env);
  if (word === "help" || word === "--help") {
    console.log(help);
    if (!pack?.words.length) return 0;
    console.log(`\nFrom packs: ${pack.words.join(", ")}\n`);
    await runHandler(["bun", pack.handler, "help"], env);
    return 0;
  }
  if (!engineSubcommands.includes(word)) throw new Error(`Usage: fleet pr <subcommand>, one of ${[...engineSubcommands, ...(pack?.words ?? [])].join(", ")}. Run fleet pr --help for each one's flags.`);
  if (word === "handover") return console.log(JSON.stringify(await recordHandover(args.slice(1), home, env.T3CODE_THREAD_ID, now))), 0;
  if (args[0] === "review" || args[0] === "stamp" || args[0] === "forecast") return askReviewBot(parseReviewBotArgs(args[0], args.slice(1)));
  const report = args[0] === "blockers"
    ? await prBlockers(parseBlockerArgs(args.slice(1)), runGh, join(home, ".local/state/fleet/pr-blockers"), new Date())
    : await botThreads(parsePrArgs(args), runGh);
  console.log(report.output);
  return report.exitCode;
}
