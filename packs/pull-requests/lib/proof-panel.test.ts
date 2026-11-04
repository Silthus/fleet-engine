import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanFixtures, settings, checkout, clean, verdict, fakeModel } from "./proof-testing.ts";

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
  const check = readFileSync(join(pr.pullRequest, "reviews/1/findings.md"), "utf8").split("## Anchor check")[1]!;
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
