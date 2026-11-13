import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnAsync } from "../../../src/testing/spawn.ts";
import { cleanFixtures, settings, checkout, clean, verdict, fakeModel, recordingModel, fixture, stalledOnQuota, panelGuide, acceptGap, hubAt, type Checkout } from "./proof-testing.ts";
import { askModel } from "./proof-models.ts";
import { withSlot, type PanelIO } from "./proof-panel.ts";

afterEach(cleanFixtures);

test("fleet proof review --lens runs each PANEL.md lens on its lane's family, and the judge weighs their joined answers as findings captured by fleet", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
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
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
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
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
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

test("a lens stuck on spent quota fails at once without a second attempt, and --wait exits 4 until the rerun passes", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const attempts = join(pr.home, "attempts");
  pr.env.FLEET_PROOF_QUOTA_GRACE_MS = "0";
  pr.env.FLEET_PROOF_REVIEWER = `echo attempt >> "${attempts}"; ${stalledOnQuota("exceeded retry limit, last status: 429 Too Many Requests")}`;

  await pr.fleet("review", "--lens", "correctness");
  expect(readFileSync(attempts, "utf8")).toBe("attempt\n");
  const failed = await pr.fleet("review", "--wait");
  expect(failed.code).toBe(4);
  expect(failed.output).toContain('correctness: failed by gpt (command: echo attempt');
  expect(failed.output).toContain('quota exhausted: no progress after "exceeded retry limit, last status: 429 Too Many Requests" (after 1 attempt)');
  expect(failed.output).toContain("A lens stopped on spent quota");

  fakeModel(pr, "REVIEWER", clean);
  await pr.fleet("review", "--lens", "correctness");
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
});

test("a lens waits for a free panel slot of the machine, and --wait restarts a lens whose worker died", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
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
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.advanceBase("REVIEW.md", "Flag every unchecked webhook signature.\n");
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

const exitedPid = async () => (await spawnAsync(["true"])).pid;

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
    writeFileSync(join(io.slots, "0"), String(await exitedPid()));
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
    writeFileSync(join(io.slots, "0"), JSON.stringify({ pid: await exitedPid(), token: "dead", reviewer: reviewer.pid }));
    await withSlot(io, async () => undefined);
    await reviewer.exited;
    expect(reviewer.signalCode).toBe("SIGKILL");
  } finally { reviewer.kill("SIGKILL"); }

  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const slots = join(pr.home, ".local/state/fleet/proof/.panel-slots");
  const seen = join(pr.home, "slot-seen");
  pr.env.FLEET_PROOF_REVIEWER = `cat >/dev/null; echo $$ > "${seen}.pid"; until grep -qs reviewer "${slots}"/[0-9]*; do :; done; cat "${slots}"/[0-9]* > "${seen}"; printf 'FINDINGS:\\n(none)\\nCOVERED: feature.txt\\n'`;
  await pr.fleet("review", "--lens", "correctness");
  expect(JSON.parse(readFileSync(seen, "utf8"))).toMatchObject({ pid: process.pid, reviewer: Number(readFileSync(`${seen}.pid`, "utf8")) });
});

test("--wait stops the reviewer of a lens whose worker died before it restarts the lens", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", clean);
  pr.panel.lostWorkers = true;
  await pr.fleet("review", "--lens", "correctness");
  pr.panel.lostWorkers = false;
  const slots = join(pr.home, ".local/state/fleet/proof/.panel-slots");
  mkdirSync(slots, { recursive: true });
  const reviewer = Bun.spawn(["sleep", "30"], { detached: true });
  try {
    writeFileSync(join(slots, "2"), JSON.stringify({ pid: await exitedPid(), token: "dead", reviewer: reviewer.pid }));
    expect((await pr.fleet("review", "--wait")).code).toBe(0);
    await reviewer.exited;
    expect(reviewer.signalCode).toBe("SIGKILL");
    expect(readdirSync(slots).filter((name) => !name.startsWith("."))).toEqual([]);
  } finally { reviewer.kill("SIGKILL"); }
});

test("only entries inside a lens's FINDINGS block need answers, not its summary", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
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
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
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

async function authorRound(pr: Checkout, ...args: string[]) {
  const reserved = JSON.parse((await pr.fleet("review-start", ...args)).output) as { id: string };
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  expect((await pr.fleet("review-finish", "--round", reserved.id, "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
}

test("the gate needs a finished --lens panel round: a single reviewer never covers HEAD, and a final read after the panel covers a new HEAD", async () => {
  const single = await checkout();
  await single.commit("feature.txt", "greet\n");
  await single.fleet("require", "--none", "--reason", "docs only");
  await authorRound(single, "--scope", "full");
  const refused = await single.fleet("gate");
  expect(refused.code).toBe(1);
  expect(refused.output).toContain("review: no finished panel round on the PR; 1 single-reviewer review(s) do not count. Run the qa-swarm panel with fleet proof review --lens");
  const before = await single.git("rev-parse", "HEAD");
  await single.commit("feature.txt", "greet the member\n");
  fakeModel(single, "REVIEWER", clean);
  await single.fleet("review", "--lens", "correctness", "--scope", "fixes", "--base", before);
  expect((await single.fleet("review", "--wait")).code).toBe(0);
  expect((await single.fleet("gate", "--commit", before)).output).toContain("review: HEAD not reviewed, last review covered");

  const pr = await checkout();
  const reviewed = await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", clean);
  await pr.fleet("review", "--lens", "correctness");
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  expect((await pr.fleet("gate")).code).toBe(0);
  await pr.commit("feature.txt", "greet the member\n");
  await authorRound(pr, "--scope", "final", "--base", reviewed);
  const after = await pr.fleet("gate");
  expect(after.code).toBe(0);
  expect(after.output).toContain("review: HEAD reviewed in final read 1 by gpt-6.1-sol");
});

test("a panel gap holds the gate until the user accepts it, and still needs a review at HEAD", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reason = "A prune lane runs no QA swarm under the user's rules";
  await pr.fleet("gap", "--kind", "panel", "--reason", reason);
  expect((await pr.fleet("gate")).output).toContain(`review: HEAD not reviewed; panel gap from`);
  expect((await pr.fleet("gate")).code).toBe(1);

  await authorRound(pr, "--scope", "full");
  const unaccepted = await pr.fleet("gate");
  expect(unaccepted.code).toBe(3);
  expect(unaccepted.output).toMatch(new RegExp(`review: HEAD reviewed in round 1 by gpt-6\\.1-sol; panel gap from \\w{7}, not accepted: ${reason}`));

  pr.chooseGap("panel", reason);
  await acceptGap(pr, "panel");
  expect((await pr.fleet("gate")).code).toBe(0);
});

test("a round after the PR merged its base reads and demands only the files the PR changes", async () => {
  const pr = await checkout();
  const reviewed = await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", clean);
  await pr.fleet("review", "--lens", "correctness");
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const fixed = await pr.commit("feature.txt", "greet the member\n");

  await pr.fleet("review", "--lens", "correctness", "--scope", "fixes", "--base", reviewed);
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  const brief = reviewer.prompts().at(-1)!;
  expect(brief).toContain("+greet the member");
  expect(brief).not.toContain("the base moves on");
  expect(brief).toContain("It leaves out 1 file(s) that a merge of the base brought in.");

  await pr.advanceBase("base.md", "the base moves again\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("feature.txt", "greet every member\n");
  reviewer.answer("No findings.");
  await pr.fleet("review", "--scope", "final", "--base", fixed);
  const read = reviewer.prompts().at(-1)!;
  expect(read).toContain("+greet every member");
  expect(read).not.toContain("the base moves again");
  expect(read).toContain("It leaves out 1 file(s) that a merge of the base brought in.");
});

test("after a base merge, a round keeps the PR's renames and non-ASCII file names whole", async () => {
  const pr = await checkout();
  const greeting = "greet\nwelcome\nshow the rules\npoint to the help page\n";
  const reviewed = await pr.commit("feature.txt", greeting);
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", clean);
  await pr.fleet("review", "--lens", "correctness");
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.git("mv", "feature.txt", "grüße.txt");
  await pr.commit("grüße.txt", `${greeting}greet the member\n`);
  reviewer.answer("FINDINGS:\n(none)\nCOVERED: grüße.txt\n");

  await pr.fleet("review", "--lens", "correctness", "--scope", "fixes", "--base", reviewed);
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  const brief = reviewer.prompts().at(-1)!;
  expect(brief).toContain("rename from feature.txt");
  expect(brief).toContain("+greet the member");
  expect(brief).not.toContain("the base moves on");
  expect(brief).toContain("It leaves out 1 file(s)");
});

test("a panel that fails to plan gives its round back, so the same command plans it again", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", clean);
  const guide = join(pr.home, ".agents/skills/qa-swarm/PANEL.md");
  writeFileSync(guide, panelGuide.replace("Goal: <goal>", "Goal: the title"));
  await expect(pr.fleet("review", "--lens", "correctness")).rejects.toThrow("has no <goal>");

  writeFileSync(guide, panelGuide);
  const started = await pr.fleet("review", "--lens", "correctness");
  expect(JSON.parse(started.output.split("\n")[0]!)).toMatchObject({ round: 1 });
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
});

test("a panel the user's override starts but that fails to plan keeps the answer for the same command", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", clean);
  const guide = join(pr.home, ".agents/skills/qa-swarm/PANEL.md");
  writeFileSync(guide, panelGuide.replace("Goal: <goal>", "Goal: the title"));
  pr.choose("Run one more round");
  const review = () => pr.fleet("review", "--lens", "correctness", "--override", `2026-10-25 "Run one more round"`);
  await expect(review()).rejects.toThrow("has no <goal>");

  writeFileSync(guide, panelGuide);
  const started = await review();
  expect(JSON.parse(started.output.split("\n")[0]!)).toMatchObject({ round: 1 });
});

const overrideReview = ["review", "--lens", "correctness", "--override", `2026-10-25 "Run one more round"`];

async function overridePanel() {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", clean);
  pr.choose("Run one more round");
  return { pr, reviewer };
}

async function expectCountedPanel(pr: Checkout) {
  fakeModel(pr, "JUDGE", verdict());
  const gate = await pr.fleet("gate");
  expect(gate.output).toContain("review: HEAD reviewed in round 1");
  expect(gate.code).toBe(0);
  const decisions = (await pr.decide("list", "--pr", "example/product#42")).output.split("\n").filter((line) => line.startsWith("- "));
  const round = JSON.parse(readFileSync(join(pr.pullRequest, "reviews/1/round.json"), "utf8"));
  expect(decisions).toEqual([expect.stringContaining(`[${round.decision.id}]`)]);
}

test("a panel whose decision never reached the ledger starts no lens while the hub is down, and the same command records that decision and runs the round", async () => {
  const { pr, reviewer } = await overridePanel();
  const hub = hubAt(pr, "stalls on appends");
  void pr.fleet(...overrideReview);
  await hub.appendStalled;
  hub.state.hub = "down";

  await expect(pr.fleet("review", "--wait")).rejects.toThrow("Run the same command again once the hub is back");
  await expect(pr.fleet(...overrideReview)).rejects.toThrow("Run the same command again once the hub is back");
  expect(existsSync(join(pr.pullRequest, "reviews/1/lenses/correctness.prompt.md"))).toBe(true);
  expect(reviewer.prompts()).toEqual([]);

  hub.state.hub = "up";
  expect((await pr.fleet(...overrideReview)).code).toBe(0);
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  await expectCountedPanel(pr);
});

test("a retry while the first command's decision is on its way to the ledger records that same decision and runs the round, and the first command then ends without a second panel", async () => {
  const { pr, reviewer } = await overridePanel();
  const hub = hubAt(pr, "stalls on appends");
  const first = pr.fleet(...overrideReview);
  await hub.appendStalled;
  hub.state.hub = "up";

  expect((await pr.fleet(...overrideReview)).code).toBe(0);
  hub.releaseAppends();
  expect((await first).code).toBe(0);
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  expect(reviewer.prompts()).toHaveLength(1);
  await expectCountedPanel(pr);
});

test("two retries at once while the first command's decision is on its way record one decision and run one panel", async () => {
  const { pr, reviewer } = await overridePanel();
  const hub = hubAt(pr, "stalls on appends");
  const first = pr.fleet(...overrideReview);
  await hub.appendStalled;
  hub.state.hub = "up";

  const retries = await Promise.all([pr.fleet(...overrideReview), pr.fleet(...overrideReview)]);
  expect(retries.map(({ code }) => code)).toEqual([0, 0]);
  hub.releaseAppends();
  expect((await first).code).toBe(0);
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  expect(reviewer.prompts()).toHaveLength(1);
  await expectCountedPanel(pr);
});

test("when the first command publishes a panel that a retry already published, it ends without starting the lenses again", async () => {
  const { pr, reviewer } = await overridePanel();
  const hub = hubAt(pr, "stalls after it lands an append");
  const first = pr.fleet(...overrideReview);
  await hub.appendStalled;
  hub.state.hub = "up";

  expect((await pr.fleet(...overrideReview)).code).toBe(0);
  hub.releaseAppends();
  const late = await first;
  expect(late.code).toBe(0);
  expect(reviewer.prompts()).toHaveLength(1);
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  await expectCountedPanel(pr);
});

for (const resume of [overrideReview, ["review", "--wait"], ["review", "--wait", "--round", "1"]]) {
  test(`a panel whose process dies after its decision reached the ledger, before its plan exists, resumes with ${resume.join(" ")} and asks for no new answer`, async () => {
    const { pr, reviewer } = await overridePanel();
    const hub = hubAt(pr, "stalls after it lands an append");
    void pr.fleet(...overrideReview);
    await hub.appendStalled;
    hub.state.hub = "up";
    expect(reviewer.prompts()).toEqual([]);

    await pr.fleet(...resume);
    expect((await pr.fleet("review", "--wait")).code).toBe(0);
    expect(reviewer.prompts()).toHaveLength(1);
    await expectCountedPanel(pr);
  });
}

test("a panel whose plan fails to publish after its decision reached the ledger keeps its round, and the same command resumes it", async () => {
  const { pr } = await overridePanel();
  const hub = hubAt(pr, "up");
  const plan = join(pr.pullRequest, "reviews/1/panel.json");
  hub.state.afterAppend = () => mkdirSync(plan);
  await expect(pr.fleet(...overrideReview)).rejects.toThrow();
  hub.state.afterAppend = undefined;
  expect(existsSync(join(pr.pullRequest, "reviews/1/round.json"))).toBe(true);
  rmSync(plan, { recursive: true, force: true });

  expect((await pr.fleet(...overrideReview)).code).toBe(0);
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  await expectCountedPanel(pr);
});

test("rerunning a failed lens rebuilds its brief and runs it in the checkout of now", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", "Looks fine to me.");
  const cwds = join(pr.home, "reviewer-cwds");
  pr.env.FLEET_PROOF_REVIEWER = `pwd >> "${cwds}"; ${pr.env.FLEET_PROOF_REVIEWER}`;
  writeFileSync(join(pr.repository, "incidents.md"), "No incident yet.\n");
  await pr.fleet("review", "--lens", "correctness", "--knowledge", "correctness=incidents.md");
  expect((await pr.fleet("review", "--wait")).code).toBe(1);

  const other = fixture("fleet-proof-other-checkout-");
  await pr.git("worktree", "add", "-q", "--detach", other, head);
  writeFileSync(join(other, "incidents.md"), "A greeting once leaked a member's email.\n");
  reviewer.answer(clean);
  await pr.fleetIn(other, "review", "--lens", "correctness", "--knowledge", "correctness=incidents.md");
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  expect(reviewer.prompts().at(-1)).toContain("A greeting once leaked a member's email.");
  expect(readFileSync(cwds, "utf8").trim().split("\n").at(-1)).toBe(realpathSync(other));
});
