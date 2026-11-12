import type { Gh } from "./gh.ts";

export type BotThreadOptions = { repo: string; pr: number; resolve?: boolean; fixed?: string[] };
export type ThreadReport = { output: string; exitCode: 0 | 1 };

type Author = { __typename: string; login: string } | null;
type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type Comment = { author: Author; url: string; reactions?: { nodes: { user: { login: string } | null }[] } };
type GraphThread = { id: string; isResolved: boolean; path: string; line: number | null; originalLine: number | null; comments: Page<Comment> };
type Thread = { id: string; kind: "bot" | "human"; answered: boolean; location: string; url: string };

const usage = "Usage: fleet pr bot-threads|blockers --repo <owner/repo> --pr <number> [--resolve] [--fixed <thread URL>]... | [--record]";
const knownBots = new Set(["coderabbitai", "greptile-apps", "posthog-bot", "trunk-io", "github-actions", "dependabot", "renovate", "vercel", "codecov"]);

const commentFields = "pageInfo { hasNextPage endCursor } nodes { url author { __typename login } reactions(content: THUMBS_UP, first: 20) { nodes { user { login } } } }";
const threadsQuery = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id isResolved path line originalLine comments(first: 100) { ${commentFields} } }
  } } }
}`;
const commentsQuery = `query($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $after) { ${commentFields} } } } }`;
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
    if (arg === "--fixed" && value?.startsWith("https://")) { (options.fixed ??= []).push(value); continue; }
    throw new Error(usage);
  }
  if (!options.repo || !options.pr) throw new Error(usage);
  return options as BotThreadOptions;
}

export async function botThreads(options: BotThreadOptions, gh: Gh): Promise<ThreadReport> {
  const { viewer, threads } = await fetchThreads(options, gh);
  let unresolved = threads.filter((thread) => !thread.isResolved).map((thread) => classify(thread, viewer));
  if (!unresolved.length) return { output: "No unresolved review threads.", exitCode: 0 };
  const lines = unresolved.map((thread) => `${thread.kind} ${thread.answered ? "answered" : "unanswered"} ${thread.location} ${thread.url}`);
  if (options.fixed?.length) {
    const fixed = await resolveFixed(unresolved, options.fixed, gh);
    lines.push(...fixed.lines);
    unresolved = unresolved.filter((thread) => !fixed.resolved.has(thread.id));
  }
  if (options.resolve) lines.push(...await resolveAnswered(unresolved, gh));
  const unanswered = unresolved.filter((thread) => thread.kind === "bot" && !thread.answered).length;
  if (unanswered) lines.push(`${unanswered} unanswered bot thread${unanswered === 1 ? "" : "s"} remain${unanswered === 1 ? "s" : ""}.`);
  const waiting = unresolved.filter((thread) => thread.kind === "human" && !thread.answered).length;
  if (waiting) lines.push(`${waiting} human thread${waiting === 1 ? "" : "s"} wait${waiting === 1 ? "s" : ""} on ${viewer}: react 👍 to a fix, or draft the reply for ${viewer} to post.`);
  return { output: lines.join("\n"), exitCode: unanswered ? 1 : 0 };
}

async function fetchThreads(options: BotThreadOptions, gh: Gh): Promise<{ viewer: string; threads: GraphThread[] }> {
  const [owner, repo] = options.repo.split("/") as [string, string];
  const threads: GraphThread[] = [];
  let viewer = "";
  let after: string | null = null;
  do {
    const response = await graphql(gh, threadsQuery, ["-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${options.pr}`], after);
    const page: Page<GraphThread> | undefined = response.data?.repository?.pullRequest?.reviewThreads;
    if (!page) throw new Error(`No pull request ${options.repo}#${options.pr}`);
    viewer = response.data.viewer.login;
    threads.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  for (const thread of threads) thread.comments.nodes.push(...await remainingComments(thread, gh));
  return { viewer, threads };
}

async function remainingComments(thread: GraphThread, gh: Gh): Promise<Comment[]> {
  const comments: Comment[] = [];
  let after = thread.comments.pageInfo.hasNextPage ? thread.comments.pageInfo.endCursor : null;
  while (after) {
    const page: Page<Comment> = (await graphql(gh, commentsQuery, ["-f", `id=${thread.id}`], after)).data.node.comments;
    comments.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  }
  return comments;
}

async function graphql(gh: Gh, query: string, variables: string[], after: string | null) {
  return JSON.parse(await gh(["api", "graphql", "-f", `query=${query}`, ...variables, ...(after ? ["-f", `after=${after}`] : [])]));
}

function classify(thread: GraphThread, viewer: string): Thread {
  const comments = thread.comments.nodes;
  const others = comments.filter((comment) => comment.author?.login !== viewer);
  const line = thread.line ?? thread.originalLine;
  return {
    id: thread.id,
    kind: isBot(comments[0]?.author ?? null) && others.every((comment) => isBot(comment.author)) ? "bot" : "human",
    answered: comments.at(-1)?.author?.login === viewer || (comments.at(-1)?.reactions?.nodes ?? []).some((reaction) => reaction.user?.login === viewer),
    location: line === null ? thread.path : `${thread.path}:${line}`,
    url: comments[0]?.url ?? "",
  };
}

function isBot(author: Author): boolean {
  if (!author) return false;
  return author.__typename === "Bot" || author.login.endsWith("[bot]") || knownBots.has(author.login);
}

async function resolveFixed(threads: Thread[], urls: string[], gh: Gh): Promise<{ lines: string[]; resolved: Set<string> }> {
  const lines: string[] = [];
  const resolved = new Set<string>();
  for (const url of urls) {
    const thread = threads.find((candidate) => candidate.url === url);
    if (!thread) { lines.push(`not found among unresolved threads: ${url}`); continue; }
    if (thread.kind !== "bot") { lines.push(`skipped human thread, the person resolves it: ${url}`); continue; }
    if (resolved.has(thread.id)) continue;
    await gh(["api", "graphql", "-f", `query=${resolveMutation}`, "-f", `id=${thread.id}`]);
    resolved.add(thread.id);
    lines.push(`resolved fixed ${thread.location} ${url}`);
  }
  return { lines, resolved };
}

async function resolveAnswered(threads: Thread[], gh: Gh): Promise<string[]> {
  const lines: string[] = [];
  for (const thread of threads.filter((thread) => thread.kind === "bot" && thread.answered)) {
    await gh(["api", "graphql", "-f", `query=${resolveMutation}`, "-f", `id=${thread.id}`]);
    lines.push(`resolved ${thread.location} ${thread.url}`);
  }
  return lines;
}
