import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  const result = await runPackCommand("decisions", ["1"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify({ "orchestration.tracker": repository }) });

  expect(result).toEqual({ stdout: `${expected}\n`, stderr: "", code: 0 });
});

test("fleet decisions takes the newest answer by edit time, so an edited comment counts from its edit", async () => {
  const edited: GitHubFixture = {
    issues: [issueNode(repository, 1, { children: [issueNode(repository, 2, { state: "CLOSED" }), issueNode(repository, 3, { state: "CLOSED" })] })],
    discussions: {
      "acme/maps#2": { body: "", comments: [{ author: "ada", body: "- 👤 **Which db?** Postgres", url: url(2, "monday"), createdAt: "2026-11-02T09:00:00Z", updatedAt: "2026-11-04T09:00:00Z" }] },
      "acme/maps#3": { body: "", comments: [{ author: "bo", body: "- 👤 **Which db?** MySQL", url: url(3, "tuesday"), createdAt: "2026-11-03T09:00:00Z", updatedAt: "2026-11-03T09:00:00Z" }] },
    },
  };
  const want = ["| Question | Answer | Who | Where |", "| --- | --- | --- | --- |", `| Which db? | Postgres | 👤 Human | [#2](${url(2, "monday")}) |`, "", "Involvement: no human-in-the-loop tickets."].join("\n");
  const lines: string[] = [];

  await runDecisions(["acme/maps#1"], { ...fixtureFetchers(edited), tracker: () => "", print: (line) => lines.push(line) });

  expect(lines.join("\n")).toBe(want);
  const home = await mkdtemp(join(tmpdir(), "fleet-decisions-"));
  cleanups.push(home);
  const bin = await fakeGitHub(home, edited);
  expect(await runPackCommand("decisions", ["acme/maps#1"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: "{}" })).toEqual({ stdout: `${want}\n`, stderr: "", code: 0 });
  const discussionQueries = (await readFile(join(bin, "queries.log"), "utf8")).split("\n").filter((query) => query.includes("comments("));
  expect(discussionQueries.length).toBeGreaterThan(0);
  expect(discussionQueries.every((query) => /comments\(.*nodes \{.*\bupdatedAt\b/.test(query))).toBe(true);
});

test("fleet decisions counts answers in the map's comments next to its body and its closed tickets", async () => {
  const commented: GitHubFixture = {
    issues: [issueNode(repository, 1, { children: [issueNode(repository, 2, { state: "CLOSED" })] })],
    discussions: {
      "acme/maps#1": {
        body: "- 👤 **Which store?** Postgres",
        comments: [
          { author: "ada", body: "- 🤖 **Which queue?** SQS", url: url(1, "c1"), createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-01T09:00:00Z" },
          { author: "bo", body: "- 👤 **Which store?** CockroachDB", url: url(1, "c2"), createdAt: "2026-11-05T09:00:00Z", updatedAt: "2026-11-05T09:00:00Z" },
        ],
      },
      "acme/maps#2": { body: "", comments: [{ author: "ada", body: "- 👤 **Which store?** SQLite", url: url(2, "c3"), createdAt: "2026-11-03T09:00:00Z", updatedAt: "2026-11-03T09:00:00Z" }] },
    },
  };
  const lines: string[] = [];

  await runDecisions(["acme/maps#1"], { ...fixtureFetchers(commented), tracker: () => "", print: (line) => lines.push(line) });

  expect(lines.join("\n")).toBe([
    "| Question | Answer | Who | Where |",
    "| --- | --- | --- | --- |",
    `| Which store? | CockroachDB | 👤 Human | [map](${url(1, "c2")}) |`,
    `| Which queue? | SQS | 🤖 Agent | [map](${url(1, "c1")}) |`,
    "",
    "Involvement: no human-in-the-loop tickets.",
  ].join("\n"));
});

test("fleet decisions shows old ✅ lines as their own group after the three marks", async () => {
  const body = ["- ✅ **Old question?** Old answer", "- 🤖 **Agent question?** Took A", "- 👤 **Human question?** His answer"].join("\n");
  const lines: string[] = [];

  await runDecisions(["acme/maps#1"], { ...fixtureFetchers({ issues: [issueNode(repository, 1)], discussions: { "acme/maps#1": { body, comments: [] } } }), tracker: () => "", print: (line) => lines.push(line) });

  const where = `[map #1](https://github.com/${repository}/issues/1)`;
  expect(lines.join("\n")).toBe([
    "| Question | Answer | Who | Where |",
    "| --- | --- | --- | --- |",
    `| Human question? | His answer | 👤 Human | ${where} |`,
    `| Agent question? | Took A | 🤖 Agent | ${where} |`,
    `| Old question? | Old answer | ✅ Unmarked (before 2026-11-13) | ${where} |`,
    "",
    "Involvement: no human-in-the-loop tickets.",
  ].join("\n"));
});

test("fleet decisions ignores an example decision inside a longer fence", async () => {
  const body = ["- 👤 **Which store?** Postgres", "````md", "Write answers like this:", "```", "- 🤖 **Which store?** An example", "```", "````"].join("\n");
  const lines: string[] = [];

  await runDecisions(["acme/maps#1"], { ...fixtureFetchers({ issues: [issueNode(repository, 1)], discussions: { "acme/maps#1": { body, comments: [] } } }), tracker: () => "", print: (line) => lines.push(line) });

  expect(lines.join("\n")).toBe(["| Question | Answer | Who | Where |", "| --- | --- | --- | --- |", `| Which store? | Postgres | 👤 Human | [map #1](https://github.com/${repository}/issues/1) |`, "", "Involvement: no human-in-the-loop tickets."].join("\n"));
});

test("fleet decisions refuses a bad map", async () => {
  const io = { ...fixtureFetchers({ issues: [] }), tracker: () => "", print: () => {} };
  const usage = "Usage: fleet decisions <map URL | owner/repo#number | number>";
  await expect(runDecisions([], io)).rejects.toThrow(usage);
  await expect(runDecisions(["acme/maps"], io)).rejects.toThrow(usage);
});
