import type { Gh } from "./gh.ts";

export type BotThreadOptions = { repo: string; pr: number; resolve?: boolean };
export type ThreadReport = { output: string; exitCode: 0 | 1 };

type Author = { __typename: string; login: string } | null;
type GraphThread = {
  id: string; isResolved: boolean; path: string; line: number | null; originalLine: number | null;
  comments: { nodes: { author: Author; url: string }[] };
};
type Thread = { id: string; kind: "bot" | "human"; answered: boolean; location: string; url: string };

const usage = "Usage: fleet pr bot-threads|blockers --repo <owner/repo> --pr <number> [--resolve | --record]";
const knownBots = new Set(["coderabbitai", "greptile-apps", "posthog-bot", "trunk-io", "github-actions", "dependabot", "renovate", "vercel", "codecov"]);

const threadsQuery = `query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes {
    id isResolved path line originalLine
    comments(first: 100) { nodes { url author { __typename login } } }
  } } } }
}`;
const resolveMutation = "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }";

export function parsePrArgs(args: string[]): BotThreadOptions {
  const [subcommand, ...rest] = args;
  if (subcommand !== "bot-threads") throw new Error(usage);
  const options: Partial<BotThreadOptions> = {};
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === "--resolve") { options.resolve = true; continue; }
    const value = rest.shift();
    if (arg === "--repo" && value && /^[^/\s]+\/[^/\s]+$/.test(value)) { options.repo = value; continue; }
    if (arg === "--pr" && value && /^\d+$/.test(value)) { options.pr = Number(value); continue; }
    throw new Error(usage);
  }
  if (!options.repo || !options.pr) throw new Error(usage);
  return options as BotThreadOptions;
}

export async function botThreads(options: BotThreadOptions, gh: Gh): Promise<ThreadReport> {
  const { viewer, threads } = await fetchThreads(options, gh);
  const unresolved = threads.filter((thread) => !thread.isResolved).map((thread) => classify(thread, viewer));
  if (!unresolved.length) return { output: "No unresolved review threads.", exitCode: 0 };
  const lines = unresolved.map((thread) => `${thread.kind} ${thread.answered ? "answered" : "unanswered"} ${thread.location} ${thread.url}`);
  if (options.resolve) lines.push(...await resolveAnswered(unresolved, gh));
  const unanswered = unresolved.filter((thread) => thread.kind === "bot" && !thread.answered).length;
  if (unanswered) lines.push(`${unanswered} unanswered bot thread${unanswered === 1 ? "" : "s"} remain${unanswered === 1 ? "s" : ""}.`);
  return { output: lines.join("\n"), exitCode: unanswered ? 1 : 0 };
}

async function fetchThreads(options: BotThreadOptions, gh: Gh): Promise<{ viewer: string; threads: GraphThread[] }> {
  const [owner, repo] = options.repo.split("/") as [string, string];
  const response = JSON.parse(await gh(["api", "graphql", "-f", `query=${threadsQuery}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${options.pr}`]));
  const pullRequest = response.data?.repository?.pullRequest;
  if (!pullRequest) throw new Error(`No pull request ${options.repo}#${options.pr}`);
  return { viewer: response.data.viewer.login, threads: pullRequest.reviewThreads.nodes };
}

function classify(thread: GraphThread, viewer: string): Thread {
  const comments = thread.comments.nodes;
  const others = comments.filter((comment) => comment.author?.login !== viewer);
  const line = thread.line ?? thread.originalLine;
  return {
    id: thread.id,
    kind: others.length && others.every((comment) => isBot(comment.author)) ? "bot" : "human",
    answered: comments.at(-1)?.author?.login === viewer,
    location: line === null ? thread.path : `${thread.path}:${line}`,
    url: comments[0]?.url ?? "",
  };
}

function isBot(author: Author): boolean {
  if (!author) return false;
  return author.__typename === "Bot" || author.login.endsWith("[bot]") || knownBots.has(author.login);
}

async function resolveAnswered(threads: Thread[], gh: Gh): Promise<string[]> {
  const lines: string[] = [];
  for (const thread of threads.filter((thread) => thread.kind === "bot" && thread.answered)) {
    await gh(["api", "graphql", "-f", `query=${resolveMutation}`, "-f", `id=${thread.id}`]);
    lines.push(`resolved ${thread.location} ${thread.url}`);
  }
  return lines;
}
