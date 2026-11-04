import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { runLessons, type LessonsIo } from "./lessons.ts";
import { missesPath } from "../../pull-requests/lib/proof-misses.ts";
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

async function writeLedger(home: string): Promise<string> {
  const reviews = (pr: number) => join(ledgerRoot(home), "acme/app", String(pr), "reviews");
  for (const [pr, round] of [[10, "1"], [10, "2"], [10, "3"], [11, "1"]] as const) {
    await mkdir(join(reviews(pr), round), { recursive: true });
    await writeFile(join(reviews(pr), round, "findings.md"), "Findings.");
  }
  await mkdir(join(reviews(10), "4"), { recursive: true });
  await writeFile(join(reviews(10), "3", "round.json"), JSON.stringify({ arbiter: { verdict: "escalate", reason: "scope grew" } }));
  await writeFile(missesPath(home), [
    JSON.stringify({ repo: "acme/app", pr: 11, finding: "Null check", source: "human" }),
    JSON.stringify({ repo: "acme/app", pr: 99, finding: "Elsewhere", source: "human" }),
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

function io(home: string, lines: string[], rolloutLog = ""): LessonsIo {
  return { ...fixtureFetchers(fixture), home, host: "this-box", tracker: () => "", rolloutLog: () => rolloutLog, print: (line) => lines.push(line) };
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

test("fleet lessons refuses bad arguments", async () => {
  const home = await temporaryHome();
  const usage = "Usage: fleet lessons <map URL | owner/repo#number | number> [--rollouts <file>]";
  for (const args of [[], ["acme/maps#1", "--rollouts"], ["acme/maps#1", "--other", "x"], ["acme/maps#1", "--rollouts", "x", "y"], ["--local", "--prs", "acme/app#1"]]) {
    await expect(runLessons(args, io(home, []))).rejects.toThrow(usage);
  }
});
