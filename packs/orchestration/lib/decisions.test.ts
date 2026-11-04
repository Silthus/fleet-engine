import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDecisions } from "./decisions.ts";
import { fakeGitHub, fixtureFetchers, issueNode, runPackCommand, type GitHubFixture } from "./testing.ts";

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});

const repository = "acme/maps";
const url = (number: number, comment: string) => `https://github.com/${repository}/issues/${number}#${comment}`;
const comment = (author: string, body: string, number: number, createdAt: string) => ({ author, body, url: url(number, `c-${author}-${createdAt.slice(11, 13)}`), createdAt });

const fixture: GitHubFixture = {
  issues: [issueNode(repository, 1, {
    title: "Ship the maps", labels: ["wayfinder:map"],
    children: [
      issueNode(repository, 2, { state: "CLOSED", labels: ["wayfinder:grilling"], assignees: ["ada"] }),
      issueNode(repository, 3, { state: "CLOSED", labels: ["wayfinder:prototype"], assignees: ["ada"] }),
      issueNode(repository, 4, { labels: ["wayfinder:task"], assignees: ["ada"] }),
    ],
  })],
  discussions: {
    "acme/maps#1": { body: "Intro.\n- 👤 **Which store?** Postgres\n```\n- 🤖 **Hidden?** inside a fence\n```", comments: [] },
    "acme/maps#2": { body: "", comments: [comment("ada", "- 👍🏽 **Which cache?** Redis | in memory", 2, "2026-11-02T01:00:00Z")] },
    "acme/maps#3": {
      body: "",
      comments: [
        comment("ada", "Round one.\n- 🤖 **Which store?** SQLite", 3, "2026-11-03T01:00:00Z"),
        comment("bo", "Looks good.", 3, "2026-11-03T02:00:00Z"),
        comment("ada", "* 👤️ **Which colour?** Blue", 3, "2026-11-03T03:00:00Z"),
      ],
    },
    "acme/maps#4": { body: "", comments: [comment("ada", "- 👤 **Still open?** Not counted", 4, "2026-11-03T04:00:00Z")] },
  },
};

const expected = [
  "| Question | Answer | Who | Where |",
  "| --- | --- | --- | --- |",
  `| Which colour? | Blue | 👤 Human | [#3](${url(3, "c-ada-03")}) |`,
  `| Which cache? | Redis \\| in memory | 👍 Accepted default | [#2](${url(2, "c-ada-01")}) |`,
  `| Which store? | SQLite | 🤖 Agent | [#3](${url(3, "c-ada-01")}) |`,
  "",
  "Involvement: 1 grilling answered, 1 prototype iterated over 2 rounds.",
].join("\n");

test("fleet decisions tables the newest answer per question from the map and its closed tickets", async () => {
  const lines: string[] = [];

  const code = await runDecisions(["acme/maps#1"], { ...fixtureFetchers(fixture), tracker: () => "", print: (line) => lines.push(line) });

  expect(lines.join("\n")).toBe(expected);
  expect(code).toBe(0);
});

test("fleet decisions says when a map has no decisions and no human-in-the-loop tickets", async () => {
  const lines: string[] = [];
  const empty = { issues: [issueNode(repository, 1, { children: [issueNode(repository, 2, { state: "CLOSED" })] })] };

  await runDecisions(["acme/maps#1"], { ...fixtureFetchers(empty), tracker: () => "", print: (line) => lines.push(line) });

  expect(lines.join("\n")).toBe("No load-bearing decisions.\n\nInvolvement: no human-in-the-loop tickets.");
});

test("fleet decisions runs as a pack command against the tracker from the settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "fleet-decisions-"));
  cleanups.push(home);
  const bin = await fakeGitHub(home, fixture);

  const result = await runPackCommand("decisions", ["1"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify({ "orchestration.mapTracker": repository }) });

  expect(result).toEqual({ stdout: `${expected}\n`, stderr: "", code: 0 });
});

test("fleet decisions refuses a bad map", async () => {
  const io = { ...fixtureFetchers({ issues: [] }), tracker: () => "", print: () => {} };
  const usage = "Usage: fleet decisions <map URL | owner/repo#number | number>";
  await expect(runDecisions([], io)).rejects.toThrow(usage);
  await expect(runDecisions(["acme/maps"], io)).rejects.toThrow(usage);
});
