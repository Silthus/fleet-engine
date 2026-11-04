import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { startT3Stub, type T3Fixture, type T3Stub } from "../../base/lib/t3/testing.ts";
import { linkedEnvironment, linkedItem, linkedThread, linkedTools, minutesAgo, now, shellThread } from "./testing.ts";
import { needsHuman, runLanes } from "./lanes.ts";
import type { Discussion, IssueNode } from "./wayfinder.ts";

const command = join(import.meta.dir, "..", "commands", "lanes.ts");
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function stub(fixture: T3Fixture): Promise<T3Stub> {
  const started = await startT3Stub(fixture);
  cleanups.push(() => started.stop());
  return started;
}

type Ticket = { number: number; thread?: string; state?: string; labels?: string[]; assignees?: string[] };

const tickets: Ticket[] = [
  { number: 2, thread: "mcp:local-lane" },
  { number: 3, thread: "mcp:linked-stalled" },
  { number: 4, thread: "mcp:linked-waiting" },
  { number: 5, thread: "mcp:linked-archived" },
  { number: 6, thread: "linked-finished" },
  { number: 7, thread: "mcp:nowhere" },
  { number: 8, thread: "mcp:linked-busy" },
  { number: 9, thread: "mcp:linked-finished", state: "CLOSED" },
  { number: 10, thread: "mcp:linked-finished", labels: ["wayfinder:task", "wayfinder:awaiting-human"] },
  { number: 11, thread: "mcp:local-grilling", labels: ["wayfinder:grilling"] },
];

function issue(ticket: Ticket): IssueNode {
  return {
    number: ticket.number, title: `Ticket ${ticket.number}`, state: ticket.state ?? "OPEN", repository: "acme/maps",
    assignees: ticket.assignees ?? ["someone"], labels: ticket.labels ?? ["wayfinder:task"], blockedBy: [], childCount: 0, children: [],
  };
}

function discussion(ticket: Ticket): Discussion {
  const body = `<!-- orchestration-wayfinder-dispatch -->\nDispatched.\nThread: \`${ticket.thread}\``;
  return { body: "", comments: ticket.thread ? [{ author: "someone", body, url: `https://github.com/acme/maps/issues/${ticket.number}#c`, createdAt: minutesAgo(500) }] : [] };
}

const map: IssueNode = { ...issue({ number: 1, labels: ["wayfinder:map"] }), childCount: tickets.length, children: tickets.map(issue) };

const fixture: T3Fixture = {
  shell: {
    projects: [],
    threads: [
      shellThread("mcp:local-lane", { status: "completed", latestRunCompletedAt: minutesAgo(20) }),
      shellThread("mcp:local-grilling", { status: "completed", latestRunCompletedAt: minutesAgo(20) }),
    ],
  },
  turnItems: {
    "mcp:local-lane": [
      { item: { type: "user_message", text: "Go", startedAt: minutesAgo(60) } },
      { item: { type: "assistant_message", text: "I stopped here.\n**NEEDS_HUMAN: pick a name**", startedAt: minutesAgo(20) } },
    ],
  },
  links: [linkedEnvironment],
  tools: linkedTools([
    linkedThread("mcp:linked-stalled", { status: "running", updatedAt: minutesAgo(45) }),
    linkedThread("mcp:linked-waiting", { status: "waiting", updatedAt: minutesAgo(1), pendingRequestCount: 1 }),
    linkedThread("mcp:linked-archived", { archived: true }),
    linkedThread("mcp:linked-finished", { status: "completed", items: [linkedItem("user_message", "Go"), linkedItem("assistant_message", "All done.\nNEEDS_HUMAN: is a quote here, not at the end\nDone.")] }),
    linkedThread("mcp:linked-busy", { status: "completed", updatedAt: minutesAgo(200) }),
    linkedThread("mcp:linked-busy-child", { status: "running", parentThreadId: "mcp:linked-busy", updatedAt: minutesAgo(3) }),
  ]),
};

const expected = (host: string) => [
  "Lanes of acme/maps#1 that need attention:",
  `  #2 task needs the human: pick a name. Ask them with the question tool, then send the answer to its thread. Thread mcp:local-lane on ${host}.`,
  "  #3 task stalled: running with no activity for 45m. Read its thread, and stop it when it is past its cap. Thread mcp:linked-stalled on devbox-2.",
  "  #4 task blocked: waits on an approval or an answer nobody sees in thread mcp:linked-waiting. Thread mcp:linked-waiting on devbox-2.",
  "  #5 task gone: its thread is archived or deleted. Reconcile the ticket as an orphaned lane. Thread mcp:linked-archived on devbox-2.",
  "  #6 task finished: ended its turn with the ticket open. Read its result and act on it. Thread linked-finished on devbox-2.",
  "  #7 task gone: no box has its thread mcp:nowhere. Reconcile the ticket as an orphaned lane.",
];

test("fleet lanes finds each lane on this machine or a linked environment and names the ones that need the conductor", async () => {
  const t3 = await stub(fixture);
  const lines: string[] = [];
  const fetchIssue = async (_owner: string, _repo: string, number: number) => (number === 1 ? map : issue(tickets.find((ticket) => ticket.number === number)!));
  const fetchDiscussion = async (_owner: string, _repo: string, number: number) => discussion(tickets.find((ticket) => ticket.number === number)!);

  const code = await runLanes(["https://github.com/acme/maps/issues/1"], { home: t3.home, host: "this-box", now, fetchIssue, fetchDiscussion, print: (line) => lines.push(line) });

  expect(lines.join("\n")).toBe(expected("this-box").join("\n"));
  expect(code).toBe(1);
  expect(t3.toolCalls.every(({ args }) => args.environmentId === "env-linked")).toBe(true);
});

test("fleet lanes runs as a pack command against GitHub through gh and the local T3 server", async () => {
  const t3 = await stub({ ...fixture, tools: linkedTools([linkedThread("mcp:linked-finished", { status: "completed", items: [linkedItem("assistant_message", "Done.")] })]) });
  const bin = join(t3.home, "bin");
  await mkdir(bin);
  const graph = (value: unknown) => JSON.stringify({ data: { repository: { issue: value } } });
  const graphIssue = (node: IssueNode): Record<string, unknown> => ({
    number: node.number, title: node.title, state: node.state, repository: { nameWithOwner: node.repository },
    assignees: { nodes: node.assignees.map((login) => ({ login })) }, labels: { nodes: node.labels.map((name) => ({ name })) },
    blockedBy: { nodes: [] }, subIssuesSummary: { total: node.childCount }, subIssues: { nodes: node.children.map(graphIssue) },
  });
  const graphDiscussion = (value: Discussion) => ({ body: value.body, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: value.comments.map(({ author, ...rest }) => ({ author: { login: author }, ...rest })) } });
  const shown = [{ number: 2, thread: "mcp:local-lane" }, { number: 6, thread: "linked-finished" }];
  await writeFile(join(bin, "issue-1.json"), graph(graphIssue({ ...map, childCount: 2, children: shown.map(issue) })));
  for (const ticket of shown) await writeFile(join(bin, `discussion-${ticket.number}.json`), graph(graphDiscussion(discussion(ticket))));
  await writeFile(join(bin, "gh"), `#!/bin/sh
for arg; do case "$arg" in number=*) number=\${arg#number=} ;; *subIssues*) kind=issue ;; esac; done
cat "$(dirname "$0")/\${kind:-discussion}-$number.json"
`);
  await chmod(join(bin, "gh"), 0o755);

  const child = Bun.spawn(["bun", command, "acme/maps#1", "--stall", "60"], { env: { ...Bun.env, HOME: t3.home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: "{}" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  expect(stderr).toBe("");
  expect(stdout).toBe(`${[expected(hostname())[0], expected(hostname())[1], expected(hostname())[5]].join("\n")}\n`);
  expect(code).toBe(1);
});

test("fleet lanes refuses a bad map or stall, and says when no lane needs attention", async () => {
  const t3 = await stub({ shell: { projects: [], threads: [] } });
  const io = { home: t3.home, host: "this-box", now, print: () => {}, fetchIssue: async () => ({ ...map, children: [] }), fetchDiscussion: async () => ({ body: "", comments: [] }) };
  const usage = "Usage: fleet lanes <map URL | owner/repo#number> [--stall minutes]";
  await expect(runLanes([], io)).rejects.toThrow(usage);
  await expect(runLanes(["acme/maps#1", "--stall", "soon"], io)).rejects.toThrow(usage);
  await expect(runLanes(["not a map"], io)).rejects.toThrow(usage);
  const lines: string[] = [];
  expect(await runLanes(["acme/maps#1"], { ...io, print: (line) => lines.push(line) })).toBe(0);
  expect(lines).toEqual(["No lane of acme/maps#1 needs attention."]);
});

test("only the last line of a lane's final message asks for the human", () => {
  expect(needsHuman("Done.\n`NEEDS_HUMAN: choose the region`")).toBe("choose the region");
  expect(needsHuman("NEEDS_HUMAN:")).toBe("no ask given");
  expect(needsHuman("NEEDS_HUMAN: quoted\nDone.")).toBeNull();
});
