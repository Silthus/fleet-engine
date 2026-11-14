import { afterEach, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDisplay } from "./proof-display.ts";
import { publishProof, type GitHub } from "./proof-publish.ts";
import { checkout, cleanFixtures, fakeModel, graded, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const ref = { repository: "example/product", pr: 42 };
const png = (seed: string) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(seed)]);
const file = (pr: Checkout, name: string, content: string | Buffer) => { writeFileSync(join(pr.repository, name), content); return name; };
const tick = (pr: Checkout) => { pr.clock.now = new Date(pr.clock.now.getTime() + 60_000); };

async function proofRow(pr: Checkout) {
  const report = (await pr.decide("report", "--pr", "example/product#42")).output.split("\n");
  return report.find((line) => line.startsWith("| example/product#42 |"));
}

test("ran, result and caption stay out of the gate's and the judge's evidence, and lines saved after the gate keep its summary", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--kinds", "live-run,ui-walk");
  const judge = fakeModel(pr, "JUDGE", verdict());
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent a test email to the sandbox inbox", "--result", "Delivered in one attempt", file(pr, "run.log", "sent 1 message, delivered\n"));
  await pr.fleet("save", "--kind", "ui-walk", "--caption", "Settings page after the save", file(pr, "after.png", png("after")));

  expect((await pr.fleet("gate")).code).toBe(0);
  const [prompt] = judge.prompts();
  expect(prompt).toContain("sent 1 message, delivered");
  for (const text of ["Sent a test email", "Delivered in one attempt", "Settings page after the save"]) expect(prompt).not.toContain(text);
  const commit = join(pr.pullRequest, head);
  expect([readdirSync(join(commit, "live-run")).length, readdirSync(join(commit, "ui-walk")).length]).toEqual([1, 1]);
  const gated = await proofRow(pr);
  expect(gated).toContain(`live-run at ${head.slice(0, 7)}`);

  expect((await pr.fleet("save", "--kind", "live-run", "--ran", "Sent two test emails", "--result", "Both delivered")).code).toBe(0);
  tick(pr);
  await pr.fleet("save", "--kind", "ui-walk", "--caption", "The settings page after the save", "after.png");
  expect(await proofRow(pr)).toBe(gated);
  expect(readdirSync(join(commit, "live-run")).length).toBe(1);

  await pr.fleet("save", "--kind", "live-run", file(pr, "second.log", "a second run, delivered\n"));
  const display = await readDisplay(pr.home, ref);
  expect(display.lines[head]).toEqual({ "live-run": { ran: "Sent two test emails", result: "Both delivered" } });
  expect(display.screenshots.map(({ caption, captionedAt }) => [caption, captionedAt])).toEqual([["The settings page after the save", "2026-10-25T12:00:00.000Z"]]);
});

test("captioned screenshots read in first-caption order, and a published one shows its URL", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  const first = file(pr, "first.png", png("first"));
  await pr.fleet("save", "--kind", "ui-walk", "--caption", "Open the settings page", first);
  tick(pr);
  await pr.fleet("save", "--kind", "ui-walk", "--caption", "Save the new sender", file(pr, "second.png", png("second")));
  tick(pr);
  await pr.fleet("save", "--kind", "ui-walk", "--caption", "Open the email settings page", first);
  const published = "c".repeat(40);
  const github: GitHub = async (path, _body, method = "GET") => {
    if (path === "user") return { login: "tester" };
    if (path === "repos/tester/assets") return { permissions: { push: true }, private: false, owner: { login: "tester" }, default_branch: "main" };
    if (path.startsWith("repos/tester/assets/git/ref/heads/")) return { object: { sha: "d".repeat(40) } };
    if (path.startsWith("repos/tester/assets/contents/") && method === "GET") throw Object.assign(new Error("not found"), { status: 404 });
    if (path.startsWith("repos/tester/assets/contents/") && method === "PUT") return { commit: { sha: published } };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const url = await publishProof(pr.home, { ...ref, commit: head }, join(pr.repository, first), "tester/assets", github);

  const shots = (await readDisplay(pr.home, ref)).screenshots.map(({ caption, url }) => ({ caption, url }));
  expect(shots).toEqual([{ caption: "Open the email settings page", url }, { caption: "Save the new sender", url: undefined }]);
  expect(url).toStartWith(`https://raw.githubusercontent.com/tester/assets/${published}/`);
});

test("save refuses lines and captions it cannot place", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  const log = file(pr, "run.log", "delivered\n");
  const shot = file(pr, "shot.png", png("shot"));
  const refusals: [string[], string][] = [
    [["--kind", "live-run", "--ran", "Sent a test email", log], "Pass --ran and --result together"],
    [["--ran", "Sent a test email", "--result", "Delivered", log], "--ran and --result need --kind"],
    [["--kind", "live-run", "--caption", "A log", log], "--caption needs --kind ui-walk"],
    [["--kind", "ui-walk", "--caption", "Two at once", shot, file(pr, "other.png", png("other"))], "--caption names one screenshot"],
    [["--kind", "live-run", "--ran", "Sent", "--result", "Delivered", "--reuse-from", "HEAD", "--reason", "Same code"], "A reused kind shows the lines of the commit it reuses"],
    [["--kind", "live-run", "--ran", " ", "--result", "Delivered"], "--ran needs one line of text"],
    [["--kind", "live-run", "--ran", "Sent\nand read", "--result", "Delivered"], "--ran needs one line of text"],
    [["--kind", "live-run"], "Pass at least one file"],
  ];
  for (const [args, message] of refusals) await expect(pr.fleet("save", ...args)).rejects.toThrow(message);
  expect(await readDisplay(pr.home, ref)).toEqual({ lines: {}, screenshots: [] });
});

