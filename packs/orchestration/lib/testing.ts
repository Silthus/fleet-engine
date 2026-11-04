import type { LinkedEnvironment, LinkedThread, LinkedTimelineItem, ShellThread } from "../../base/lib/t3/index.ts";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolRefusal, type ToolHandler } from "../../base/lib/t3/testing.ts";
import { git } from "../../../src/testing/git.ts";
import { engineSource, skillSources } from "../../../src/testing/packs.ts";
import type { Discussion, FetchDiscussion, FetchIssue, IssueNode } from "./wayfinder.ts";

export const now = new Date("2026-11-04T12:00:00Z");
export const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

export const linkedEnvironment: LinkedEnvironment = {
  environmentId: "env-linked", label: "devbox-2", urls: ["https://devbox-2.example.test"], access: "read-only",
  linkedAt: "2026-11-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", lastReachedAt: null, lastError: null, status: "reachable",
};

export function shellThread(id: string, fields: Partial<ShellThread> = {}): ShellThread {
  return { id, title: `Thread ${id}`, projectId: "project-local", status: "idle", createdAt: minutesAgo(600), ...fields };
}

export type LinkedThreadFixture = LinkedThread & { archived?: boolean; pendingRequestCount?: number; branch?: string | null; items?: LinkedTimelineItem[] };

export function linkedThread(threadId: string, fields: Partial<LinkedThreadFixture> = {}): LinkedThreadFixture {
  return {
    threadId, projectId: "project-linked", title: `Thread ${threadId}`, status: "idle", model: "model-a",
    parentThreadId: null, settled: false, snoozedUntil: null, pullRequests: [], itemCount: 2,
    createdAt: minutesAgo(600), updatedAt: minutesAgo(300), ...fields,
  };
}

export function linkedItem(type: string, text: string, fields: Partial<LinkedTimelineItem> = {}): LinkedTimelineItem {
  return { position: 0, itemId: `${type}-${text.length}`, type, text, createdBy: type === "user_message" ? "user" : "agent", creationSource: type === "user_message" ? "web" : "provider", updatedAt: minutesAgo(300), ...fields };
}

export function linkedTools(threads: LinkedThreadFixture[]): ToolHandler {
  return (name, args) => {
    if (args.environmentId !== linkedEnvironment.environmentId) throw new ToolRefusal("invalid_request", "unknown environment");
    if (name === "t3_project_list") return { projects: [{ id: "project-linked", title: "Linked project" }], nextCursor: null };
    if (name === "t3_thread_list") {
      const listed = threads.filter((thread) => !thread.archived && (args.includeSubagents || !thread.parentThreadId) && (args.settled === undefined || thread.settled === args.settled));
      return { projectId: null, currentThreadId: null, threads: listed.map(({ archived, pendingRequestCount, branch, items, ...item }) => item), nextCursor: null, total: listed.length };
    }
    if (name === "t3_thread_read") {
      const thread = threads.find((candidate) => candidate.threadId === args.threadId);
      if (!thread) throw new ToolRefusal("not_found", `No thread ${args.threadId}`);
      const items = (thread.items ?? []).map((item, position) => ({ ...item, position }));
      const after = typeof args.afterPosition === "number" ? args.afterPosition : -1;
      const view = args.view === "activity" ? items : items.filter((item) => ["user_message", "assistant_message"].includes(item.type));
      const page = view.filter((item) => item.position > after).slice(0, Number(args.limit ?? 50));
      const { archived, pendingRequestCount, branch, items: _, ...detail } = thread;
      return {
        thread: { ...detail, itemCount: items.length, archived: Boolean(archived), pendingRequestCount: pendingRequestCount ?? 0, branch: branch ?? null, worktreePath: null },
        recentRuns: [], items: page, nextPosition: page.at(-1)?.position ?? null, hasMore: view.some((item) => item.position > (page.at(-1)?.position ?? after)),
      };
    }
  };
}

export type GitHubFixture = { issues: IssueNode[]; discussions?: Record<string, Discussion> };
export type CommandResult = { stdout: string; stderr: string; code: number };

export function issueNode(repository: string, number: number, fields: Partial<IssueNode> = {}): IssueNode {
  return { number, title: `Ticket ${number}`, state: "OPEN", repository, assignees: [], labels: ["wayfinder:task"], blockedBy: [], childCount: fields.children?.length ?? 0, children: [], ...fields };
}

export function fixtureFetchers(fixture: GitHubFixture): { fetchIssue: FetchIssue; fetchDiscussion: FetchDiscussion } {
  const issue = (owner: string, repo: string, number: number) => fixture.issues.find((node) => node.repository === `${owner}/${repo}` && node.number === number);
  return {
    fetchIssue: async (owner, repo, number) => issue(owner, repo, number) ?? Promise.reject(new Error(`No issue ${owner}/${repo}#${number}`)),
    fetchDiscussion: async (owner, repo, number) => fixture.discussions?.[`${owner}/${repo}#${number}`] ?? { body: "", comments: [] },
  };
}

export async function fakeGitHub(home: string, fixture: GitHubFixture): Promise<string> {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  const name = (repository: string, number: number) => `${repository.replace("/", "-")}-${number}.json`;
  const graph = (value: unknown) => JSON.stringify({ data: { repository: { issue: value } } });
  for (const node of fixture.issues) await writeFile(join(bin, `issue-${name(node.repository, node.number)}`), graph(graphIssue(node)));
  for (const [key, value] of Object.entries(fixture.discussions ?? {})) {
    const [repository, number] = key.split("#") as [string, string];
    await writeFile(join(bin, `discussion-${name(repository, Number(number))}`), graph(graphDiscussion(value)));
  }
  await writeFile(join(bin, "gh"), `#!/bin/sh
for arg; do case "$arg" in owner=*) owner=\${arg#owner=} ;; repo=*) repo=\${arg#repo=} ;; number=*) number=\${arg#number=} ;; *subIssues*) kind=issue ;; esac; done
echo "$owner/$repo#$number" >> "$(dirname "$0")/calls.log"
file="$(dirname "$0")/\${kind:-discussion}-$owner-$repo-$number.json"
[ -f "$file" ] || { [ "\${kind:-}" = issue ] && { echo "no issue $owner/$repo#$number" >&2; exit 1; }; echo '{"data":{"repository":{"issue":{"body":"","comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}'; exit 0; }
cat "$file"
`);
  await chmod(join(bin, "gh"), 0o755);
  return bin;
}

export async function runPackCommand(command: string, args: string[], env: Record<string, string>): Promise<CommandResult> {
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "commands", `${command}.ts`), ...args], { env: { ...Bun.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

export async function fleetMachine(home: string, settings: Record<string, unknown>, origin?: string): Promise<string> {
  const profile = join(home, "profile");
  const sources = skillSources(join(home, ".local/share/fleet/sources"), await engineSource());
  for (const source of sources) await mkdir(join(source.dir, ".git"), { recursive: true });
  await mkdir(profile, { recursive: true });
  const engine = { repo: "acme/fleet-engine", ref: "main", channel: "track" };
  await writeFile(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine, sources: sources.map((source) => source.ref), packs: ["pull-requests", "orchestration"], plan: "both", settings, workflows: {} }));
  git(profile, "init", "-q");
  if (origin) git(profile, "remote", "add", "origin", origin);
  await mkdir(join(home, ".config/fleet"), { recursive: true });
  await writeFile(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "linux", profileDir: profile }));
  return profile;
}

export async function runFleet(args: string[], env: Record<string, string>): Promise<CommandResult> {
  const { FLEET_SETTINGS, FLEET_PROFILE_DIR, ...inherited } = Bun.env;
  const child = Bun.spawn(["sh", join(import.meta.dir, "../../../fleet"), ...args], { env: { ...inherited, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

function graphIssue(node: IssueNode): Record<string, unknown> {
  return {
    number: node.number, title: node.title, state: node.state, repository: { nameWithOwner: node.repository },
    assignees: { nodes: node.assignees.map((login) => ({ login })) }, labels: { nodes: node.labels.map((name) => ({ name })) },
    blockedBy: { nodes: node.blockedBy.map(({ repository, ...blocker }) => ({ ...blocker, repository: { nameWithOwner: repository } })) },
    subIssuesSummary: { total: node.childCount }, subIssues: { nodes: node.children.map(graphIssue) },
  };
}

function graphDiscussion(value: Discussion): Record<string, unknown> {
  return { body: value.body, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: value.comments.map(({ author, ...rest }) => ({ author: { login: author }, ...rest })) } };
}
