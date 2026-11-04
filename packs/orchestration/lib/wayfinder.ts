export type Blocker = { number: number; state: string; repository: string };
export type IssueNode = {
  number: number; title: string; state: string; repository: string;
  assignees: string[]; labels: string[]; blockedBy: Blocker[]; childCount: number; children: IssueNode[];
};
export type Ticket = IssueNode & { parent?: number };
export type MapRef = { owner: string; repo: string; number: number };
export type Comment = { author: string; body: string; url: string; createdAt: string };
export type Discussion = { body: string; comments: Comment[] };
export type FetchIssue = (owner: string, repo: string, number: number) => Promise<IssueNode>;
export type FetchDiscussion = (owner: string, repo: string, number: number) => Promise<Discussion>;

export type Tracker = () => string;
export type MapIo = { print(line: string): void; tracker: Tracker; fetchIssue?: FetchIssue; fetchDiscussion?: FetchDiscussion };

export const parked = "wayfinder:awaiting-human";
export const trackerSetting = "orchestration.mapTracker";
const fence = /^\s*(```|~~~)/;

export function mapRef(value: string, usage: string, tracker: Tracker = () => ""): MapRef {
  const bare = value.match(/^#?(\d+)$/);
  if (bare) return { ...trackerRepository(tracker()), number: Number(bare[1]) };
  const match = value.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/) ?? value.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (!match) throw new Error(usage);
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

function trackerRepository(tracker: string): { owner: string; repo: string } {
  if (!tracker) throw new Error(`Set ${trackerSetting} to the owner/repo that holds your maps, or name the map as owner/repo#number.`);
  const match = tracker.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error(`${trackerSetting} is ${tracker}, not an owner/repo.`);
  return { owner: match[1]!, repo: match[2]! };
}

export function proseLines(text: string): string[] {
  let inFence = false;
  return text.split("\n").filter((line) => {
    if (fence.test(line)) inFence = !inFence;
    return !inFence && !fence.test(line);
  });
}

export function tableCell(text: string): string {
  return text.replace(/(?<!\\)\|/g, "\\|");
}

export function issueLink({ owner, repo, number }: MapRef): string {
  return `https://github.com/${owner}/${repo}/issues/${number}`;
}

export async function descendants(issue: IssueNode, fetchIssue: FetchIssue, parent?: number): Promise<Ticket[]> {
  const tickets: Ticket[] = [];
  for (const child of issue.children) {
    tickets.push({ ...child, parent });
    if (!child.childCount) continue;
    const [owner, repo] = splitRepository(child.repository);
    tickets.push(...await descendants(await fetchIssue(owner, repo, child.number), fetchIssue, child.number));
  }
  return tickets;
}

export function ticketType(ticket: Ticket): string | undefined {
  return ticket.labels.find((label) => label.startsWith("wayfinder:") && label !== parked && label !== "wayfinder:map")?.slice("wayfinder:".length);
}

export function splitRepository(repository: string): [string, string] {
  return repository.split("/") as [string, string];
}

const fields = "number title state repository { nameWithOwner } assignees(first: 10) { nodes { login } } labels(first: 20) { nodes { name } } blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } }";
const issueQuery = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) { ${fields} subIssues(first: 100) { nodes { ${fields} subIssuesSummary { total } } } } } }`;
const discussionQuery = "query($owner: String!, $repo: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $repo) { issue(number: $number) { body comments(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { author { login } body url createdAt } } } } }";

type GraphIssue = {
  number: number; title: string; state: string; repository: { nameWithOwner: string };
  assignees: { nodes: { login: string }[] }; labels: { nodes: { name: string }[] };
  blockedBy: { nodes: { number: number; state: string; repository: { nameWithOwner: string } }[] };
  subIssuesSummary?: { total: number }; subIssues?: { nodes: GraphIssue[] };
};
type GraphDiscussion = {
  body: string;
  comments: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { author: { login: string } | null; body: string; url: string; createdAt: string }[] };
};

function issueNode(issue: GraphIssue): IssueNode {
  return {
    number: issue.number, title: issue.title, state: issue.state, repository: issue.repository.nameWithOwner,
    assignees: issue.assignees.nodes.map((node) => node.login), labels: issue.labels.nodes.map((node) => node.name),
    blockedBy: issue.blockedBy.nodes.map((node) => ({ number: node.number, state: node.state, repository: node.repository.nameWithOwner })),
    childCount: issue.subIssuesSummary?.total ?? issue.subIssues?.nodes.length ?? 0,
    children: issue.subIssues?.nodes.map(issueNode) ?? [],
  };
}

function discussion(pages: GraphDiscussion[]): Discussion {
  return {
    body: pages[0]?.body ?? "",
    comments: pages.flatMap((page) => page.comments.nodes).map((node) => ({ author: node.author?.login ?? "", body: node.body, url: node.url, createdAt: node.createdAt })),
  };
}

async function discussionPages(owner: string, repo: string, number: number): Promise<GraphDiscussion[]> {
  const pages: GraphDiscussion[] = [];
  let cursor: string | null = null;
  do {
    const page: GraphDiscussion = await queryIssue<GraphDiscussion>(discussionQuery, owner, repo, number, cursor);
    pages.push(page);
    cursor = page.comments.pageInfo.hasNextPage ? page.comments.pageInfo.endCursor : null;
  } while (cursor);
  return pages;
}

async function gh(args: string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`gh ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function queryIssue<T>(query: string, owner: string, repo: string, number: number, cursor?: string | null): Promise<T> {
  const after = cursor ? ["-f", `cursor=${cursor}`] : [];
  const response = JSON.parse(await gh(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${number}`, ...after]));
  const issue = response.data?.repository?.issue as T | undefined;
  if (!issue) throw new Error(`No issue ${owner}/${repo}#${number}`);
  return issue;
}

export const fetchIssueFromGitHub: FetchIssue = async (owner, repo, number) => issueNode(await queryIssue<GraphIssue>(issueQuery, owner, repo, number));
export const fetchDiscussionFromGitHub: FetchDiscussion = async (owner, repo, number) => discussion(await discussionPages(owner, repo, number));
