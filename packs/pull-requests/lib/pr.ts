import { join } from "node:path";
import { runGh } from "./gh.ts";
import { parseBlockerArgs, prBlockers } from "./pr-blockers.ts";
import { botThreads, parsePrArgs } from "./pr-threads.ts";

export const help = `fleet pr: review threads and blockers of a pull request

  fleet pr bot-threads --repo <owner/repo> --pr <number> [--resolve]
                     List a PR's unresolved review threads as bot or human; resolve answered bot threads
  fleet pr blockers --repo <owner/repo> --pr <number> [--record]
                     List what blocks a PR; with --record, exit 3 when a fix left the same blockers`;

export async function prCommand(args: string[], home: string): Promise<number> {
  if (args[0] === "help" || args[0] === "--help") return console.log(help), 0;
  const report = args[0] === "blockers"
    ? await prBlockers(parseBlockerArgs(args.slice(1)), runGh, join(home, ".local/state/fleet/pr-blockers"), new Date())
    : await botThreads(parsePrArgs(args), runGh);
  console.log(report.output);
  return report.exitCode;
}
