import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { runLessons, type LessonsIo } from "./lessons.ts";
import { missesPath, type Miss } from "../../pull-requests/lib/proof-misses.ts";
import { ledgerRoot } from "../../pull-requests/lib/proof.ts";
import { fakeGitHub, fixtureFetchers, issueNode, runPackCommand, type GitHubFixture } from "./testing.ts";

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "fleet-lessons-"));
  cleanups.push(home);
  return home;
}

const repository = "acme/maps";
const mapBody = [
  "Goal.",
  "- ❌ **Cache in memory** Lost on restart",
  "## Stacks",
  "- acme/app#10 then acme/app#11",
  "- acme/app#12 and acme/app#10 again",
  "## Notes",
  "- acme/app#99 is not on the board",
].join("\n");

const fixture: GitHubFixture = {
  issues: [issueNode(repository, 1, { labels: ["wayfinder:map"], children: [issueNode(repository, 2), issueNode(repository, 3, { state: "CLOSED" })] })],
  discussions: {
    "acme/maps#1": { body: mapBody, comments: [{ author: "ada", body: "- ❌ **Skip the flag** Broke staging", url: `https://github.com/${repository}/issues/1#c1`, createdAt: "2026-11-02T00:00:00Z" }] },
    "acme/maps#3": { body: "", comments: [{ author: "ada", body: "```\n- ❌ **Fenced** ignored\n```\n- ❌ **Use a | pipe** It split", url: `https://github.com/${repository}/issues/3#c2`, createdAt: "2026-11-03T00:00:00Z" }] },
  },
};

const failures = [
  "| Tried | What happened | Where |",
  "| --- | --- | --- |",
  `| Cache in memory | Lost on restart | [map #1](https://github.com/${repository}/issues/1) |`,
  `| Skip the flag | Broke staging | [map](https://github.com/${repository}/issues/1#c1) |`,
  `| Use a \\| pipe | It split | [#3](https://github.com/${repository}/issues/3#c2) |`,
];

function miss(fields: Partial<Miss>): string {
  return JSON.stringify({
    id: "case-1", at: "2026-11-03T00:00:00Z", repo: "acme/app", pr: 11, commit: "abc123", source: "human", finding: "Null check",
    base: "base123", head: "head123", scope: "diff", round: "1", title: "Add the cache", body: "Adds a cache.", ...fields,
  });
}

async function writeLedger(home: string): Promise<string> {
  const reviews = (pr: number) => join(ledgerRoot(home), "acme/app", String(pr), "reviews");
  for (const [pr, round] of [[10, "1"], [10, "2"], [10, "3"], [11, "1"]] as const) {
    await mkdir(join(reviews(pr), round), { recursive: true });
    await writeFile(join(reviews(pr), round, "findings.md"), "Findings.");
  }
  await mkdir(join(reviews(10), "4"), { recursive: true });
  await writeFile(join(reviews(10), "3", "round.json"), JSON.stringify({ arbiter: { verdict: "escalate", reason: "scope grew" } }));
  await writeFile(missesPath(home), [
    miss({}),
    miss({ id: "case-2", pr: 99, finding: "Elsewhere" }),
  ].join("\n"));
  const log = join(home, "rollouts.jsonl");
  await writeFile(log, [
    JSON.stringify({ repo: "acme/app", pr: 11, stage: "10%", state: "rolled-back", note: "errors rose" }),
    JSON.stringify({ repo: "acme/app", pr: 10, stage: "100%", state: "done", note: "fine" }),
  ].join("\n"));
  return log;
}

const signals = (host: string, log: string) => [
  `PR signals from the proof ledger on ${host} and the rollout log ${log}:`,
  "- acme/app#10: 3 review rounds; arbiter escalated: review 3: scope grew",
  "- acme/app#11: missed by review: Null check (human); rollout rolled-back at 10%: errors rose",
  "- No proof ledger on this machine has acme/app#12.",
];

function io(home: string, lines: string[], rolloutLog = "", warnings: string[] = []): LessonsIo {
  return { ...fixtureFetchers(fixture), home, host: "this-box", tracker: () => "", rolloutLog: () => rolloutLog, print: (line) => lines.push(line), warn: (line) => warnings.push(line) };
}

test("fleet lessons tables the map's ❌ lines and its stack PRs' review and rollout trouble", async () => {
  const home = await temporaryHome();
  const log = await writeLedger(home);
  const lines: string[] = [];

  const code = await runLessons(["acme/maps#1"], io(home, lines, "~/rollouts.jsonl"));

  expect(lines.join("\n")).toBe([...failures, "", ...signals("this-box", log)].join("\n"));
  expect(code).toBe(0);
});

test("fleet lessons takes the rollout log from --rollouts, and says when the log is missing or unset", async () => {
  const home = await temporaryHome();
  const log = await writeLedger(home);
  const run = async (args: string[], setting: string) => {
    const lines: string[] = [];
    await runLessons(args, io(home, lines, setting));
    return lines.join("\n").split("\n").find((line) => line.startsWith("PR signals"));
  };

  expect(await run(["acme/maps#1", "--rollouts", log], "")).toBe(`PR signals from the proof ledger on this-box and the rollout log ${log}:`);
  expect(await run(["acme/maps#1"], "~/missing.jsonl")).toBe(`PR signals from the proof ledger on this-box and no rollout log (${join(home, "missing.jsonl")} is missing, so holds and rollbacks are unknown):`);
  expect(await run(["acme/maps#1"], "")).toBe("PR signals from the proof ledger on this-box and no rollout log (orchestration.rolloutLog is empty, so holds and rollbacks are unknown):");
});

test("fleet lessons says when nothing went wrong and when the map has no stack PRs", async () => {
  const home = await temporaryHome();
  await mkdir(join(ledgerRoot(home), "acme/app/10/reviews/1"), { recursive: true });
  await writeFile(join(ledgerRoot(home), "acme/app/10/reviews/1/findings.md"), "Findings.");
  const quiet = (body: string): LessonsIo => ({
    ...io(home, []),
    ...fixtureFetchers({ issues: [issueNode(repository, 1)], discussions: { "acme/maps#1": { body, comments: [] } } }),
  });
  const run = async (body: string) => {
    const lines: string[] = [];
    await runLessons(["acme/maps#1"], { ...quiet(body), print: (line) => lines.push(line) });
    return lines.join("\n");
  };

  expect(await run("## Stacks\n- acme/app#10")).toBe([
    "No ❌ lines on the map or its tickets.",
    "",
    "PR signals from the proof ledger on this-box and no rollout log (orchestration.rolloutLog is empty, so holds and rollbacks are unknown):",
    "- none: no stack PR took more than two review rounds or had an escalation, a miss, a hold, or a rollback.",
  ].join("\n"));
  expect(await run("No board.")).toBe("No ❌ lines on the map or its tickets.\n\nNo stack PRs on the map's Stacks board.");
});

test("fleet lessons runs as a pack command with the tracker and rollout log from the settings", async () => {
  const home = await temporaryHome();
  const log = await writeLedger(home);
  const bin = await fakeGitHub(home, fixture);
  const settings = { "orchestration.tracker": repository, "orchestration.rolloutLog": "~/rollouts.jsonl" };

  const result = await runPackCommand("lessons", ["#1"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify(settings) });

  expect(result).toEqual({ stdout: `${[...failures, "", ...signals(hostname(), log)].join("\n")}\n`, stderr: "", code: 0 });
});

test("fleet lessons skips malformed rollout rows with a warning that names the file and line, and still reports", async () => {
  const home = await temporaryHome();
  const log = await writeLedger(home);
  await writeFile(log, [
    JSON.stringify({ repo: "acme/app", pr: 11, stage: "10%", state: "rolled-back", note: "errors rose" }),
    '{"repo":"acme/app","pr":10,"stage":"50%","state":"rolled-ba',
    "null",
    "",
    JSON.stringify({ repo: "acme/app", pr: "10", stage: "50%", state: "holding", note: "slow" }),
    JSON.stringify({ repo: "acme/app", pr: 10, stage: "50%", state: "holding" }),
    "[]",
  ].join("\n"));
  const lines: string[] = [];
  const warnings: string[] = [];

  const code = await runLessons(["acme/maps#1"], io(home, lines, log, warnings));

  expect(lines.join("\n")).toBe([...failures, "", ...signals("this-box", log)].join("\n"));
  expect(warnings).toEqual([
    `Skipped line 2 of ${log}: not valid JSON.`,
    `Skipped line 3 of ${log}: missing or mistyped fields.`,
    `Skipped line 5 of ${log}: missing or mistyped fields.`,
    `Skipped line 6 of ${log}: missing or mistyped fields.`,
    `Skipped line 7 of ${log}: missing or mistyped fields.`,
  ]);
  expect(code).toBe(0);

  const bin = await fakeGitHub(home, fixture);
  const settings = { "orchestration.tracker": repository, "orchestration.rolloutLog": log };
  const command = await runPackCommand("lessons", ["#1"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify(settings) });
  expect(command).toEqual({ stdout: `${[...failures, "", ...signals(hostname(), log)].join("\n")}\n`, stderr: `${warnings.join("\n")}\n`, code: 0 });
});

test("fleet lessons skips malformed miss ledger entries with a warning, and still reports the valid ones", async () => {
  const home = await temporaryHome();
  const log = await writeLedger(home);
  const ledger = missesPath(home);
  await writeFile(ledger, [
    "null",
    miss({}),
    '{"repo":"acme/app",',
    miss({ id: "case-3", pr: "11" as unknown as number }),
    miss({ id: "case-4", source: "gut" as Miss["source"] }),
    miss({ id: "case-5", line: "7" as unknown as number }),
    JSON.stringify({ repo: "acme/app", pr: 11, finding: "Partial", source: "human" }),
  ].join("\n"));
  const lines: string[] = [];
  const warnings: string[] = [];

  await runLessons(["acme/maps#1"], io(home, lines, log, warnings));

  expect(lines.join("\n")).toBe([...failures, "", ...signals("this-box", log)].join("\n"));
  expect(warnings).toEqual([
    ...[1, 3, 4, 5, 6].map((line) => `Skipped line ${line} of ${ledger}: ${line === 3 ? "not valid JSON" : "missing or mistyped fields"}.`),
    `Skipped 1 more line of ${ledger}.`,
  ]);
});

test("fleet lessons caps the warnings for one file, and reads no ledger for a map without stack PRs", async () => {
  const home = await temporaryHome();
  const log = await writeLedger(home);
  await writeFile(missesPath(home), Array.from({ length: 2000 }, () => "null").join("\n"));
  await writeFile(log, Array.from({ length: 2000 }, () => "null").join("\n"));
  const warnings: string[] = [];

  await runLessons(["acme/maps#1"], io(home, [], log, warnings));
  expect(warnings).toEqual([
    ...[1, 2, 3, 4, 5].map((line) => `Skipped line ${line} of ${missesPath(home)}: missing or mistyped fields.`),
    `Skipped 1995 more lines of ${missesPath(home)}.`,
    ...[1, 2, 3, 4, 5].map((line) => `Skipped line ${line} of ${log}: missing or mistyped fields.`),
    `Skipped 1995 more lines of ${log}.`,
  ]);

  const quiet: string[] = [];
  await runLessons(["acme/maps#1"], {
    ...io(home, [], log, quiet),
    ...fixtureFetchers({ issues: [issueNode(repository, 1)], discussions: { "acme/maps#1": { body: "No stacks yet.", comments: [] } } }),
  });
  expect(quiet).toEqual([]);
});

test("fleet lessons refuses bad arguments", async () => {
  const home = await temporaryHome();
  const usage = "Usage: fleet lessons <map URL | owner/repo#number | number> [--rollouts <file>]";
  for (const args of [[], ["acme/maps#1", "--rollouts"], ["acme/maps#1", "--other", "x"], ["acme/maps#1", "--rollouts", "x", "y"], ["--local", "--prs", "acme/app#1"]]) {
    await expect(runLessons(args, io(home, []))).rejects.toThrow(usage);
  }
});
