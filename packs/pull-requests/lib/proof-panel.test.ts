import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanFixtures, settings, checkout, clean, verdict, fakeModel, recordingModel, fixture } from "./proof-testing.ts";
import { askModel } from "./proof-models.ts";
import { withSlot, type PanelIO } from "./proof-panel.ts";

afterEach(cleanFixtures);

test("fleet proof review --lens runs each PANEL.md lens on its lane's family, and the judge weighs their joined answers as findings captured by fleet", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet the new member\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", clean);
  writeFileSync(join(pr.repository, "incidents.md"), "A greeting once leaked a member's email.\n");
  await expect(pr.fleet("review", "--lens", "team")).rejects.toThrow("--knowledge <perspective>=<file");

  const started = await pr.fleet("review", "--lens", "fresh-eyes", "--lens", "correctness", "--lens", "design:same", "--knowledge", "correctness=incidents.md");
  expect(JSON.parse(started.output.split("\n")[0]!)).toMatchObject({ round: 1, lenses: [{ name: "fresh-eyes", family: "claude" }, { name: "correctness", family: "gpt" }, { name: "design", family: "claude" }] });
  const [freshEyes, correctness, design] = reviewer.prompts();
  for (const prompt of [freshEyes, correctness, design]) for (const part of ["Goal: Greet new members", "+greet the new member", "- Keep things simple."]) expect(prompt).toContain(part);
  expect(freshEyes).toContain("Lens: Fresh eyes\n\nRead it as a senior engineer");
  expect(correctness).toContain("PR description: Adds the greeting.");
  expect(correctness).toContain("A greeting once leaked a member's email.");
  expect(design).toContain("Find the code judo move.");
  expect(design).not.toContain("Adds the greeting.");

  const waited = await pr.fleet("review", "--wait");
  expect(waited.code).toBe(0);
  expect(waited.output).toContain("design: done by claude");
  const findings = readFileSync(join(pr.pullRequest, "reviews/1/findings.md"), "utf8");
  expect(findings).toMatch(/^## Fresh eyes lens, by command: [^\n]+\n\nFINDINGS:\n\(none\)\nCOVERED: feature\.txt\n\n## Correctness lens/);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "reviews/1/round.json"), "utf8"))).toMatchObject({ capturedBy: "fleet" });

  const judge = fakeModel(pr, "JUDGE", verdict());
  expect((await pr.fleet("gate")).code).toBe(0);
  expect(judge.prompts()[0]).toMatch(/captured by fleet">\n## Fresh eyes lens/);
});

test("the sweep lens reads the other lenses' findings once they finish, and fleet flags a finding whose anchor is not in the diff", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet the new member\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", `FINDINGS:
- feature.txt:1 | major | Correctness | an empty name -> a blank greeting | guard it | sites: feature.txt:1 | anchor: greet the new member
- feature.txt:1 | minor | Correctness | a typo -> confusion | fix it | sites: feature.txt:1 | anchor: welcome every new member
COVERED: feature.txt
`);

  await pr.fleet("review", "--lens", "correctness", "--lens", "sweep");
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  const sweep = reviewer.prompts().at(-1)!;
  expect(sweep).toContain("Find what the other lenses missed.");
  expect(sweep).toContain("The findings of the other lenses, which you sweep:\n\n### Correctness\n\nFINDINGS:\n- feature.txt:1 | major");
  const check = readFileSync(join(pr.pullRequest, "reviews/1/anchors.md"), "utf8");
  expect(readFileSync(join(pr.pullRequest, "reviews/1/findings.md"), "utf8")).not.toContain("## Anchor check");
  expect(check).toContain("Not in the diff, so check it before triage: - feature.txt:1 | minor");
  expect(check).not.toContain("| major |");
});

test("a lens without a FINDINGS block or a full COVERED list runs once more, then keeps the round unfinished until the same command reruns it", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", "Looks fine to me.");

  await pr.fleet("review", "--lens", "correctness", "--lens", "design");
  expect(reviewer.prompts()).toHaveLength(4);
  const failed = await pr.fleet("review", "--wait");
  expect(failed.code).toBe(1);
  expect(failed.output).toContain("correctness: failed by gpt");
  expect(failed.output).toContain("no FINDINGS block (after 2 attempts)");
  expect((await pr.fleet("gate")).code).toBe(1);
  await expect(pr.fleet("review", "--lens", "correctness")).rejects.toThrow("Pass the same --lens set");
  await expect(pr.fleet("review")).rejects.toThrow("unfinished panel");

  reviewer.answer("FINDINGS:\n(none)\nCOVERED: other.txt\n");
  await pr.fleet("review", "--lens", "design", "--lens", "correctness");
  expect((await pr.fleet("show")).output).toContain("COVERED misses feature.txt (after 2 attempts)");

  reviewer.answer(clean);
  await pr.fleet("review", "--lens", "design", "--lens", "correctness:same");
  expect((await pr.fleet("review", "--wait")).output).toContain("correctness: done by claude");
  expect((await pr.fleet("show")).output.split("\n")[0]).toMatch(/^round 1 on \w+: finished by command: .*, captured by fleet/);
});

test("a lens waits for a free panel slot of the machine, and --wait restarts a lens whose worker died", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", clean);
  pr.env.FLEET_SETTINGS = JSON.stringify({ ...settings, "pull-requests.panelSlots": 1 });
  const slots = join(pr.home, ".local/state/fleet/proof/.panel-slots");
  mkdirSync(slots, { recursive: true });
  writeFileSync(join(slots, "0"), String(process.pid));

  pr.panel.lostWorkers = true;
  await pr.fleet("review", "--lens", "correctness");
  expect((await pr.fleet("show")).output).toContain("correctness: queued by gpt");

  pr.panel.lostWorkers = false;
  const whileQueued: string[] = [];
  pr.panel.onPause = async () => {
    whileQueued.push((await pr.fleet("show")).output);
    rmSync(join(slots, "0"));
  };
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  expect(whileQueued).toEqual([expect.stringContaining("correctness: queued by gpt")]);
  expect(readdirSync(slots)).toEqual([]);
});

test("a lens reads the whole diff from the round directory and REVIEW.md from the tip of the base branch, and its findings need answers, not its COVERED list", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet the new member\n");
  pr.advanceBase("REVIEW.md", "Flag every unchecked webhook signature.\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const claude = recordingModel(pr, "claude", "FINDINGS:\n- feature.txt:1 | high | the greeting names no member\nCOVERED: feature.txt");

  await pr.fleet("review", "--lens", "fresh-eyes");
  const round = join(pr.pullRequest, "reviews/1");
  expect(readFileSync(join(round, "diff.patch"), "utf8")).toContain("+greet the new member");
  expect(claude.prompt()).toContain(`is in ${join(round, "diff.patch")}`);
  expect(claude.prompt()).toContain("Flag every unchecked webhook signature.");
  expect(claude.calls()[0]).toContain(`--add-dir ${round}`);

  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  fakeModel(pr, "JUDGE", verdict());
  const unanswered = await pr.fleet("gate");
  expect(unanswered.code).toBe(1);
  expect(unanswered.output).toContain("review: round 1 has unanswered findings 1;");
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in this commit: the greeting names the member.\n");
  await pr.fleet("respond", "--round", "1", "responses.md");
  expect((await pr.fleet("gate")).code).toBe(0);
});

const exitedPid = () => Bun.spawnSync(["true"]).pid;

function slotIO(slotCount: number): PanelIO {
  return { env: {}, pause: () => new Promise((done) => setImmediate(done)), now: () => new Date(), slots: fixture("fleet-panel-slots-"), slotCount, pid: process.pid, limit: 60_000 };
}

test("claimants that find a dead worker's slot at once reclaim it once, so the panel never runs more lenses than its slots", async () => {
  const io = slotIO(1);
  const running = fixture("fleet-panel-running-");
  const claimant = join(running, "claim.ts");
  writeFileSync(claimant, `import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { withSlot } from ${JSON.stringify(join(import.meta.dir, "proof-panel.ts"))};
const [slots, running] = process.argv.slice(2);
const tick = () => new Promise((done) => setImmediate(done));
writeFileSync(running + "/ready-" + process.pid, "");
while (readdirSync(running).filter((name) => name.startsWith("ready-")).length < 4) await tick();
await withSlot({ env: {}, pause: tick, now: () => new Date(), slots, slotCount: 1, pid: process.pid, limit: 60000 }, async () => {
  writeFileSync(running + "/" + process.pid, "");
  writeFileSync(running + "/most-" + process.pid, String(readdirSync(running).filter((name) => /^\\d+$/.test(name)).length));
  for (let count = 0; count < 2000; count++) await tick();
  rmSync(running + "/" + process.pid);
});
`);
  for (let race = 0; race < 4; race++) {
    for (const name of readdirSync(running).filter((name) => name !== "claim.ts")) rmSync(join(running, name));
    writeFileSync(join(io.slots, "0"), String(exitedPid()));
    const claimants = Array.from({ length: 4 }, () => Bun.spawn(["bun", claimant, io.slots, running], { stdout: "ignore", stderr: "inherit" }));
    expect(await Promise.all(claimants.map((child) => child.exited))).toEqual([0, 0, 0, 0]);
    const most = readdirSync(running).filter((name) => name.startsWith("most-")).map((name) => Number(readFileSync(join(running, name), "utf8")));
    expect(most).toEqual([1, 1, 1, 1]);
    expect(readdirSync(io.slots).filter((name) => !name.startsWith("."))).toEqual([]);
  }
});

test("a reclaimed slot's reviewer stops with it, and a lens records its reviewer in its slot", async () => {
  const io = slotIO(1);
  const reviewer = Bun.spawn(["sleep", "30"], { detached: true });
  try {
    writeFileSync(join(io.slots, "0"), JSON.stringify({ pid: exitedPid(), token: "dead", reviewer: reviewer.pid }));
    await withSlot(io, async () => undefined);
    await reviewer.exited;
    expect(reviewer.signalCode).toBe("SIGKILL");
  } finally { reviewer.kill("SIGKILL"); }

  const pr = checkout();
  pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const slots = join(pr.home, ".local/state/fleet/proof/.panel-slots");
  const seen = join(pr.home, "slot-seen");
  pr.env.FLEET_PROOF_REVIEWER = `cat >/dev/null; echo $$ > "${seen}.pid"; until grep -qs reviewer "${slots}"/[0-9]*; do :; done; cat "${slots}"/[0-9]* > "${seen}"; printf 'FINDINGS:\\n(none)\\nCOVERED: feature.txt\\n'`;
  await pr.fleet("review", "--lens", "correctness");
  expect(JSON.parse(readFileSync(seen, "utf8"))).toMatchObject({ pid: process.pid, reviewer: Number(readFileSync(`${seen}.pid`, "utf8")) });
});

test("--wait stops the reviewer of a lens whose worker died before it restarts the lens", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", clean);
  pr.panel.lostWorkers = true;
  await pr.fleet("review", "--lens", "correctness");
  pr.panel.lostWorkers = false;
  const slots = join(pr.home, ".local/state/fleet/proof/.panel-slots");
  mkdirSync(slots, { recursive: true });
  const reviewer = Bun.spawn(["sleep", "30"], { detached: true });
  try {
    writeFileSync(join(slots, "2"), JSON.stringify({ pid: exitedPid(), token: "dead", reviewer: reviewer.pid }));
    expect((await pr.fleet("review", "--wait")).code).toBe(0);
    await reviewer.exited;
    expect(reviewer.signalCode).toBe("SIGKILL");
    expect(readdirSync(slots).filter((name) => !name.startsWith("."))).toEqual([]);
  } finally { reviewer.kill("SIGKILL"); }
});

test("only entries inside a lens's FINDINGS block need answers, not its summary", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet the new member\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", "Summary:\n- the change is one line of copy\n\nFINDINGS:\n(none)\nCOVERED: feature.txt\n");
  await pr.fleet("review", "--lens", "correctness");
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  fakeModel(pr, "JUDGE", verdict());
  const gate = await pr.fleet("gate");
  expect(gate.output).not.toContain("unanswered findings");
  expect(gate.code).toBe(0);
});

test("a heading inside a lens's FINDINGS block hides none of its findings", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet the new member\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", "FINDINGS:\n## High severity\n- feature.txt:1 | high | the greeting names no member\n- feature.txt:1 | high | the greeting skips the team\nCOVERED: feature.txt\n");
  await pr.fleet("review", "--lens", "correctness");
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  fakeModel(pr, "JUDGE", verdict());
  const gate = await pr.fleet("gate");
  expect(gate.output).toContain("review: round 1 has unanswered findings 1, 2;");
  expect(gate.code).toBe(1);
});

test("a reviewer stops when fleet cannot record it in its slot", async () => {
  let reviewer = 0;
  const started = async (pid: number) => { reviewer = pid; throw new Error("cannot write the slot"); };
  const env = { FLEET_PROOF_REVIEWER: "cat >/dev/null; exec tail -f /dev/null", PATH: process.env.PATH };
  const answer = await askModel("reviewer", { role: "lookup", work: "Find files", provider: "claude", model: "lookup-model", effort: "medium" }, { prompt: "Review this.", cwd: fixture("fleet-reviewer-"), started }, env, 60_000);
  expect(answer).toMatchObject({ ok: false, cause: expect.stringContaining("cannot write the slot") });
  expect(reviewer).toBeGreaterThan(0);
  expect(() => process.kill(reviewer, 0)).toThrow();
});
