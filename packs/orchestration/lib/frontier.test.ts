import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFrontier } from "./frontier.ts";
import { fakeGitHub, fixtureFetchers, issueNode, runPackCommand, type GitHubFixture } from "./testing.ts";
import type { IssueNode } from "./wayfinder.ts";

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "fleet-frontier-"));
  cleanups.push(home);
  return home;
}

function mapFixture(repository: string): GitHubFixture {
  const epic = issueNode(repository, 6, { title: "Epic", children: [issueNode(repository, 7, { title: "Draft schema" })] });
  const children: IssueNode[] = [
    issueNode(repository, 2, { title: "Pick a store", labels: ["wayfinder:grilling"] }),
    issueNode(repository, 3, {
      title: "Build the store",
      blockedBy: [{ number: 2, state: "OPEN", repository }, { number: 7, state: "OPEN", repository: "globex/core" }, { number: 8, state: "CLOSED", repository }],
    }),
    issueNode(repository, 4, { title: "Wire the API", assignees: ["ada"] }),
    issueNode(repository, 5, { title: "Choose a name", assignees: ["ada"], labels: ["wayfinder:grilling", "wayfinder:awaiting-human"] }),
    { ...epic, children: [] },
    issueNode(repository, 8, { title: "Spike", state: "CLOSED" }),
  ];
  return { issues: [issueNode(repository, 1, { title: "Ship the maps", labels: ["wayfinder:map"], children }), epic] };
}

const expected = (repository: string) => [
  `Map ${repository}#1: Ship the maps (6 open, 1 closed)`,
  "",
  "Frontier, open, unblocked, and unclaimed, in map order:",
  "  #2 grilling: Pick a store",
  "  #6 task: Epic",
  "  #7 task: Draft schema (under #6)",
  "Claimed:",
  "  #4 task @ada: Wire the API",
  "Parked, awaiting the human:",
  "  #5 grilling @ada: Choose a name",
  "Blocked:",
  "  #3 task: Build the store (blocked by #2, globex/core#7)",
  "Closed: #8",
].join("\n");

const noTracker = () => "";

test("fleet frontier sorts a map's open tickets into frontier, claimed, parked, and blocked", async () => {
  const lines: string[] = [];

  const code = await runFrontier(["https://github.com/acme/maps/issues/1"], { ...fixtureFetchers(mapFixture("acme/maps")), tracker: noTracker, print: (line) => lines.push(line) });

  expect(lines.join("\n")).toBe(expected("acme/maps"));
  expect(code).toBe(0);
});

test("fleet frontier says none when the frontier is empty", async () => {
  const repository = "acme/maps";
  const fixture = { issues: [issueNode(repository, 1, { title: "Done map", children: [issueNode(repository, 2, { assignees: ["ada"] })] })] };
  const lines: string[] = [];

  await runFrontier(["acme/maps#1"], { ...fixtureFetchers(fixture), tracker: noTracker, print: (line) => lines.push(line) });

  expect(lines.join("\n")).toBe(["Map acme/maps#1: Done map (1 open, 0 closed)", "", "Frontier, open, unblocked, and unclaimed, in map order:", "  none", "Claimed:", "  #2 task @ada: Ticket 2"].join("\n"));
});

test("fleet frontier runs as a pack command and finds a bare map number on the tracker from the settings", async () => {
  for (const tracker of ["acme/maps", "globex/plans"]) {
    const home = await temporaryHome();
    const bin = await fakeGitHub(home, mapFixture(tracker));

    const result = await runPackCommand("frontier", ["#1"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify({ "orchestration.mapTracker": tracker }) });

    expect(result).toEqual({ stdout: `${expected(tracker)}\n`, stderr: "", code: 0 });
    expect((await readFile(join(bin, "calls.log"), "utf8")).split("\n").filter(Boolean)).toEqual([`${tracker}#1`, `${tracker}#6`]);
  }
});

test("fleet frontier refuses a bad map, and a bare number when no tracker is set", async () => {
  const io = { ...fixtureFetchers({ issues: [] }), tracker: noTracker, print: () => {} };
  const usage = "Usage: fleet frontier <map URL | owner/repo#number | number>";
  await expect(runFrontier([], io)).rejects.toThrow(usage);
  await expect(runFrontier(["acme/maps#1", "extra"], io)).rejects.toThrow(usage);
  await expect(runFrontier(["not a map"], io)).rejects.toThrow(usage);
  await expect(runFrontier(["12"], io)).rejects.toThrow("Set orchestration.mapTracker to the owner/repo that holds your maps, or name the map as owner/repo#number.");
  await expect(runFrontier(["#12"], { ...io, tracker: () => "maps" })).rejects.toThrow("orchestration.mapTracker is maps, not an owner/repo.");

  const home = await temporaryHome();
  const result = await runPackCommand("frontier", ["#1"], { HOME: home, FLEET_SETTINGS: JSON.stringify({ "orchestration.mapTracker": "" }) });
  expect(result).toEqual({ stdout: "", stderr: "fleet: Set orchestration.mapTracker to the owner/repo that holds your maps, or name the map as owner/repo#number.\n", code: 1 });
});
