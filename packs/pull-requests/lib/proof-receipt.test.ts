import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptGap, checkout, cleanFixtures, fakeModel, graded, hubAt, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const png = (seed: string) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(seed)]);
const template = `## Problem\n\nSenders were lost.\n\n## Testing\n\nTest rationale: the send path and the settings page.\n\n- [x] I ticked this box\n\n${graded("non-critical")}`;
const block = (body: string) => /<!-- fleet-proof-receipt head=[0-9a-f]{40} hash=[0-9a-f]+ -->\n[\s\S]*?\n<!-- \/fleet-proof-receipt -->/.exec(body)?.[0] ?? "";
const patches = (pr: Checkout) => pr.githubCalls().filter((call) => call.includes("--method PATCH")).length;

function publisher(pr: Checkout) {
  const calls = join(pr.home, "publish-calls");
  const fail = join(pr.home, "publish-fails");
  const path = join(pr.home, "publish.ts");
  writeFileSync(path, `const fs = require("fs");
const request = await Bun.stdin.json();
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(request) + "\\n");
if (fs.existsSync(${JSON.stringify(fail)})) { console.log(JSON.stringify({ failed: "the receipt server answered 500" })); process.exit(1); }
const id = request.previous?.id ?? "receipt-" + fs.readFileSync(${JSON.stringify(calls)}, "utf8").trim().split("\\n").length;
console.log("publishing");
console.log(JSON.stringify({ id, url: "https://receipts.example/r/" + id }));
`);
  pr.env.FLEET_HANDLERS = JSON.stringify({ "proof-receipt": path });
  return {
    requests: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    failing: (on: boolean) => on ? writeFileSync(fail, "") : rmSync(fail, { force: true }),
  };
}

async function provedPr() {
  const pr = await checkout();
  const file = (name: string, content: string | Buffer) => { writeFileSync(join(pr.repository, name), content); return name; };
  const older = await pr.commit("feature.txt", "greet new members\n");
  await pr.fleet("save", "--kind", "ui-walk", "--ran", "Walked the sender settings page", "--result", "The new sender shows after a reload", file("walk.png", png("walk")));
  await pr.fleet("save", "--kind", "ui-walk", "--caption", "The sender settings page after the save", "walk.png");
  const head = await pr.commit("feature.txt", "greet new members by name\n");
  pr.pullRequestState({ body: template });
  await pr.fleet("require", "--kinds", "live-run,ui-walk,prod-shape,cross-version");
  await pr.fleet("save", "--kind", "ui-walk", "--reuse-from", older, "--reason", "Only the greeting text changed since");
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent a test email to the sandbox inbox", "--result", "Delivered in one attempt", file("run.log", "delivered\n"));
  await pr.fleet("save", "--kind", "prod-shape", "--ran", "Read the stored senders on one region", "--result", "Read 48,213 rows, 12% without a domain", file("shape.md", "Read 48,213 stored senders.\n"));
  await pr.fleet("gap", "--kind", "cross-version", "--reason", "The old client is retired");
  pr.chooseGap("cross-version", "The old client is retired", "Accept the gap");
  await acceptGap(pr, "cross-version");
  await reviewHead(pr);
  return { pr, older, head, file };
}

const short = (commit: string) => commit.slice(0, 7);

async function reviewAgain(pr: Checkout, round: number, reviewer = "gpt-6.1-sol") {
  expect((await pr.fleet("review-start", "--scope", "full", "--agent", "the test reviews each new head")).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  expect((await pr.fleet("review-finish", "--round", String(round), "--reviewer", reviewer, "findings.md")).code).toBe(0);
}

function installRiskSkill(pr: Checkout) {
  mkdirSync(join(pr.home, ".agents/skills/merge-risk"), { recursive: true });
  writeFileSync(join(pr.home, ".agents/skills/merge-risk/SKILL.md"), "# Merge risk\n\nGrade the blast radius of each changed row.\n");
}

test("the body section shows each owed proof, the review and the judge in the testing section, and a refresh replaces only its block", async () => {
  const { pr, older, head } = await provedPr();
  expect((await pr.fleet("gate")).code).toBe(0);

  const written = await pr.fleet("receipt", "--not-checked", "Safari", "--not-checked", "the mobile layout");
  expect(written.code).toBe(0);
  expect(written.output).toContain(`receipt written at ${short(head)}`);
  const body = pr.githubBody();
  const section = block(body);
  expect(body.replace(section, "")).toBe(template.replace("- [x] I ticked this box\n\n", "- [x] I ticked this box\n\n\n\n"));
  expect(section.split("\n").slice(1, -1)).toEqual([
    "| Proof | What ran | Result | Commit |",
    "| --- | --- | --- | --- |",
    `| live-run | Sent a test email to the sandbox inbox | Delivered in one attempt | \`${short(head)}\` |`,
    `| ui-walk | Walked the sender settings page | The new sender shows after a reload | \`${short(head)}\` (reused from \`${short(older)}\`) |`,
    `| prod-shape | Read the stored senders on one region | measured on production; details in the receipt | \`${short(head)}\` |`,
    "| cross-version | not run | gap, accepted | |",
    `| Review | single reviewer (gpt-6.1-sol), round 1 | 0 findings: 0 fixed, 0 rejected, 0 other | \`${short(head)}\` |`,
    `| Proof judge | an independent model reads the evidence against the diff | ✅ passed at \`${short(head)}\` | |`,
    "",
    "**Not checked:** Safari; the mobile layout",
    `**Gaps:** cross-version: The old client is retired, accepted by 👤 the user 2026-10-25`,
  ]);
  expect(body).not.toContain("Accept the gap");

  pr.pullRequestState({ body: body.replace("Senders were lost.", "Senders were lost on save.") });
  const current = await pr.fleet("receipt");
  expect(current.output.split("\n").at(-1)).toBe("receipt current");
  expect(patches(pr)).toBe(1);

  const next = await pr.commit("feature.txt", "greet new members by first name\n");
  await reviewAgain(pr, 2);
  await pr.fleet("save", "--kind", "live-run", "--reuse-from", head, "--reason", "Same send path");
  await pr.fleet("save", "--kind", "prod-shape", "--reuse-from", head, "--reason", "Same reads");
  await pr.fleet("save", "--kind", "ui-walk", "--reuse-from", older, "--reason", "Only the greeting text changed since");
  expect((await pr.fleet("receipt")).code).toBe(0);
  const refreshed = pr.githubBody();
  expect(refreshed.replace(block(refreshed), "")).toBe(body.replace(section, "").replace("Senders were lost.", "Senders were lost on save."));
  expect(block(refreshed)).toContain(`head=${next}`);
  expect(block(refreshed)).toContain(`| live-run | Sent a test email to the sandbox inbox | Delivered in one attempt | \`${short(next)}\` (reused from \`${short(head)}\`) |`);
  expect(block(refreshed)).toContain(`| Proof judge | an independent model reads the evidence against the diff | not yet run at \`${short(next)}\` | |`);
  expect(block(refreshed)).toContain("**Not checked:** Safari; the mobile layout");
});

test("an empty read, a body edited before the write, broken markers or a lost write refuse, and a body without the heading gets one inside the block", async () => {
  const { pr } = await provedPr();
  pr.pullRequestState({ body: "" });
  await expect(pr.fleet("receipt")).rejects.toThrow("read empty");

  pr.pullRequestState({ body: "Adds the greeting." });
  pr.whileGithubReadsPull(`printf '%s' '"Adds the greeting. Edited."' > "$(dirname "$0")/body"`);
  await expect(pr.fleet("receipt")).rejects.toThrow("The PR body changed while fleet built the receipt");
  expect(patches(pr)).toBe(0);

  const handler = publisher(pr);
  const open = `<!-- fleet-proof-receipt head=${"a".repeat(40)} hash=01 -->`;
  for (const broken of [`${open}\nold\n<!-- /fleet-proof-receipt -->\n${open}\nold\n<!-- /fleet-proof-receipt -->`, `<!-- /fleet-proof-receipt -->\n${open}`, `${open}\nunclosed`, `${open.replace(" -->", "")}\nThe rationale a person wrote.\n<!-- /fleet-proof-receipt -->`]) {
    pr.pullRequestState({ body: `Adds the greeting.\n\n${broken}\n` });
    await expect(pr.fleet("receipt")).rejects.toThrow("broken receipt markers");
  }
  for (const overlapping of [`${open}\n${graded("critical")}<!-- /fleet-proof-receipt -->\n`, `## Testing\n\n<!-- merge-risk -->\n> **Tier:** critical (b)\n\n## Rollout\n\n- **Stages:** one\n<!-- /merge-risk -->\n`]) {
    pr.pullRequestState({ body: `Adds the greeting.\n\n${overlapping}` });
    await expect(pr.fleet("receipt")).rejects.toThrow("would change the merge-risk callout");
  }
  expect(patches(pr)).toBe(0);
  expect(handler.requests()).toHaveLength(0);

  const marking = join(pr.home, "marking.ts");
  writeFileSync(marking, `await Bun.stdin.text();\nconsole.log(JSON.stringify({ id: "r1", url: "https://receipts.example/r/<!--/merge-risk-->" }));\n`);
  pr.env.FLEET_HANDLERS = JSON.stringify({ "proof-receipt": marking });
  pr.pullRequestState({ body: `Adds the greeting.\n\n<!-- merge-risk -->\n> **Tier:** critical (b)\n` });
  await expect(pr.fleet("receipt")).rejects.toThrow("would change the merge-risk callout");
  expect(patches(pr)).toBe(0);
  publisher(pr);

  pr.pullRequestState({ body: "Adds the greeting." });
  pr.githubFault("patch-mangle", "\nAn edit that raced the write.");
  await expect(pr.fleet("receipt")).rejects.toThrow("reads back different");
  pr.githubFault("patch-mangle", undefined);

  pr.pullRequestState({ body: "Adds the greeting." });
  expect((await pr.fleet("receipt")).code).toBe(0);
  const body = pr.githubBody();
  expect(body).toStartWith("Adds the greeting.\n\n<!-- fleet-proof-receipt head=");
  expect(block(body).split("\n")[1]).toBe("## Testing");
  expect(body.endsWith("<!-- /fleet-proof-receipt -->\n")).toBe(true);
  pr.pullRequestState({ body: "Adds the greeting.\n\n### Testing\n\nTest rationale.\n\n#### Detail\n\nMore rationale.\n\n### Screenshots\n\nA picture.\n" });
  expect((await pr.fleet("receipt")).code).toBe(0);
  expect(pr.githubBody().replace(block(pr.githubBody()), "<block>")).toBe("Adds the greeting.\n\n### Testing\n\nTest rationale.\n\n#### Detail\n\nMore rationale.\n\n<block>\n\n### Screenshots\n\nA picture.\n");
});

const blockShape = { ...Object.fromEntries(["paragraph", "blockquote", "code", "list", "listItem", "hr", "table", "thead", "tbody", "tr", "th", "td", "html"].map((kind) => [kind, (children: string) => `(${kind}${children})`])), heading: (_: string, meta: { level: number }) => `(h${meta.level})`, text: () => "" };
const blocksOf = (text: string) => Bun.markdown.render(text, blockShape);

test("the receipt ends the testing section at the next heading GitHub renders, and nowhere else", async () => {
  const cases: [string, string, string][] = [
    ["a heading inside an HTML comment", "<!--\n# Hidden instructions\nKeep this hidden.\n-->", "### Screenshots\n\nA picture."],
    ["a heading inside a pre block", "<pre>\n# start the app\nbun run dev\n</pre>", "### Screenshots\n\nA picture."],
    ["a heading inside a div before its blank line", "<div>\n# start the app\n</div>", "### Screenshots\n\nA picture."],
    ["a heading inside a fenced code block", "```sh\n# start the app\n```", "### Screenshots\n\nA picture."],
    ["a heading inside a quote", "> # start the app", "### Screenshots\n\nA picture."],
    ["a heading inside a list item", "- Steps:\n  # start the app", "### Screenshots\n\nA picture."],
    ["an indented heading", "Ran it by hand.", "   ### Screenshots\n\nA picture."],
    ["an underlined heading after a link definition, which stays one block", "[ref]: /image.png\n    Screenshots\n---", "### Screenshots\n\nA picture."],
    ["a body near the GitHub size limit", `<pre>\n${"# a\n".repeat(15000)}</pre>`, "### Screenshots\n\nA picture."],
  ];
  for (const [name, inside, next] of cases) {
    const { pr } = await provedPr();
    const before = `Adds the greeting.\n\n### Testing\n\nTest rationale.\n\n${inside}\n\n`;
    pr.pullRequestState({ body: `${before}${next}\n` });
    expect({ name, code: (await pr.fleet("receipt")).code }).toEqual({ name, code: 0 });
    expect({ name, body: pr.githubBody().replace(block(pr.githubBody()), "<block>") }).toEqual({ name, body: `${before}<block>\n\n${next}\n` });
    expect({ name, blocks: blocksOf(pr.githubBody()).replace(blocksOf(block(pr.githubBody())), "") }).toEqual({ name, blocks: blocksOf(`${before}${next}\n`) });
  }
});

test("a receipt added at the end of a body that ends in an HTML block starts a block of its own", async () => {
  const bodies = ["Adds the greeting.\n\n<details>\n<summary>More</summary>\n\nHidden detail.\n\n</details>", "Adds the greeting.\n\n### Testing\n\n<div>\nRan it by hand.\n</div>"];
  for (const body of bodies) {
    const { pr } = await provedPr();
    pr.pullRequestState({ body });
    expect((await pr.fleet("receipt")).code).toBe(0);
    expect(pr.githubBody().replace(block(pr.githubBody()), "<block>")).toBe(`${body}\n\n<block>\n`);
    expect(blocksOf(pr.githubBody()).replace(blocksOf(block(pr.githubBody())), "")).toBe(blocksOf(body));
  }
});

test("the body guard refuses figures and emails with the field named, and passes SHAs, versions, dates and references", async () => {
  const { pr, head } = await provedPr();
  const looksLike = "looks like a production figure or an email address";
  const refused: [string, string, string][] = [
    ["Sent 1,022 emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent emails", "12% bounced", `the result of live-run ${looksLike}`],
    ["Sent 48213 emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Mailed someone@example.com", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 4**8**213 emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent ４８２１３ emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48 213 emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 4&#56;213 emails", "Delivered", "the what ran of live-run holds an HTML entity"],
    ["Sent emails", "12.5% bounced", `the result of live-run ${looksLike}`],
    ["Sent to <someone@example.com>", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent to `<user email=\"someone@example.com\">`", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent [48](https://example.com)[213](https://example.com) emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48<b></b>213 emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Mailed \"someone\"@example.com", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent [48](https://example.com/a(b))[213](https://example.com) emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent ![48](https://example.com/a.png)213 emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48~~213~~ emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48~213~ emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48__213__ emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48<del>213</del> emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48213**abc** emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48213`abc` emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48213<b>abc</b> emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48213~~abc~~ emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent [48213](https://example.com)abc emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Mailed someone@[192.0.2.1]", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent <a href=\"https://example.com/48213\">a list</a>", "Delivered", `the what ran of live-run ${looksLike}`],
  ];
  for (const [ran, result, refusal] of refused) {
    await pr.fleet("save", "--kind", "live-run", "--ran", ran, "--result", result);
    const run = await pr.fleet("receipt");
    expect([run.code, run.output]).toEqual([2, expect.stringContaining(`receipt refused: ${refusal}`)]);
  }
  expect(patches(pr)).toBe(0);

  await pr.fleet("save", "--kind", "live-run", "--ran", "Ran 1a2b3c4 with v1.2.3 on 2026-10-25", "--result", "Delivered, as #1234 asked, and the `@example.com` filter held");
  const notChecked = await pr.fleet("receipt", "--not-checked", "Safari", "--not-checked", "Safari on 1,000 accounts");
  expect([notChecked.code, notChecked.output]).toEqual([2, expect.stringContaining("receipt refused: the not-checked item 2 looks like")]);
  expect(patches(pr)).toBe(0);
  expect((await pr.fleet("receipt")).code).toBe(0);
  const section = block(pr.githubBody());
  expect(section).toContain("**Not checked:** none recorded");
  expect(section).toContain(`| live-run | Ran 1a2b3c4 with v1.2.3 on 2026-10-25 | Delivered, as #1234 asked, and the \`@example.com\` filter held | \`${short(head)}\` |`);
  expect(section).not.toContain("48,213");
  expect(section).not.toContain("12%");
});

test("a field shows in the body as written, so markup and the body's link definitions cannot rebuild a figure", async () => {
  const { pr } = await provedPr();
  pr.pullRequestState({ body: "Adds the greeting.\n\n[r]: https://example.com\n\n### Testing\n\nTest rationale.\n" });
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent [48][r][213][r] emails", "--result", "Saw <b>it</b> & **this** in `a*b`");
  expect((await pr.fleet("receipt")).code).toBe(0);
  const shown = Bun.markdown.html(pr.githubBody()).replace(/<[^>]*>/g, "");
  expect(shown).not.toContain("48213");
  expect(shown).toContain("Sent [48][r][213][r] emails");
  expect(shown).toContain("Saw &lt;b&gt;it&lt;/b&gt; &amp; **this** in a*b");
});

test("a dated model id of a reviewer passes the guard", async () => {
  const { pr } = await provedPr();
  await pr.commit("feature.txt", "greet new members by first name\n");
  await reviewAgain(pr, 2, "claude-sonnet-4-5-20250929");
  expect((await pr.fleet("receipt")).code).toBe(0);
  expect(block(pr.githubBody())).toContain("single reviewer (gpt-6.1-sol, claude-sonnet-4-5-20250929)");
});

test("a fenced code line never starts or ends the testing section, and a tab after the hashes makes a heading", async () => {
  const { pr } = await provedPr();
  const body = "Adds the greeting.\n\n```md\n## Testing\n```\n\n##\tTesting\n\nRun it:\n\n```bash\n# start the app\nbun dev\n```\n\n~~~\n# more\n~~~\n\n## Screenshots\n\nA picture.\n";
  pr.pullRequestState({ body });
  expect((await pr.fleet("receipt")).code).toBe(0);
  const written = pr.githubBody();
  expect(written.replace(block(written), "<block>")).toBe(body.replace("## Screenshots", "<block>\n\n## Screenshots"));
});

test("a block edited by hand with its markers kept is written again", async () => {
  const { pr } = await provedPr();
  expect((await pr.fleet("receipt")).code).toBe(0);
  const written = pr.githubBody();
  pr.pullRequestState({ body: written.replace("Delivered in one attempt", "Delivered twice") });
  const run = await pr.fleet("receipt");
  expect(run.output.split("\n").at(-1)).toStartWith("receipt written at");
  expect(patches(pr)).toBe(2);
  expect(pr.githubBody()).toBe(written);
});

test("a judge that passed shows that the gate fails now when CI turns red after it", async () => {
  const { pr, head } = await provedPr();
  expect((await pr.fleet("gate")).code).toBe(0);
  pr.ci([{ name: "test", bucket: "fail" }]);
  expect((await pr.fleet("receipt")).code).toBe(0);
  expect(block(pr.githubBody())).toContain(`| Proof judge | an independent model reads the evidence against the diff | ✅ passed at \`${short(head)}\`, but the gate fails now | |`);
});

test("evidence reused and then carried across a base merge shows the lines of the commit that ran it", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: template });
  await pr.fleet("require", "--kinds", "live-run");
  writeFileSync(join(pr.repository, "run.log"), "delivered\n");
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent a test email to the sandbox inbox", "--result", "Delivered in one attempt", "run.log");
  const ran = await pr.git("rev-parse", "HEAD");
  const reused = await pr.commit("feature.txt", "greet new members by name\n");
  await pr.fleet("save", "--kind", "live-run", "--reuse-from", ran, "--reason", "Only the greeting text changed");
  await pr.advanceBase("base.txt", "base\n");
  await pr.git("merge", "-q", "--no-edit", "origin/main");
  const head = await pr.git("rev-parse", "HEAD");
  const run = await pr.fleet("receipt");
  expect(run.output).not.toContain("has no line");
  expect(block(pr.githubBody())).toContain(`| live-run | Sent a test email to the sandbox inbox | Delivered in one attempt | \`${short(head)}\` (carried from \`${short(reused)}\`) |`);
});

test("an unreachable hub ledger exits 3 and writes nothing", async () => {
  const { pr } = await provedPr();
  hubAt(pr, "down");
  const run = await pr.fleet("receipt");
  expect(run.code).toBe(3);
  expect(run.output).toContain("receipt: the hub ledger cannot be reached");
  expect(patches(pr)).toBe(0);
});

test("the gate names a receipt of an older head on the terminal only", async () => {
  const { pr, head } = await provedPr();
  expect((await pr.fleet("receipt")).code).toBe(0);
  await pr.commit("feature.txt", "greet new members by first name\n");
  await reviewAgain(pr, 2);
  const gate = await pr.fleet("gate");
  expect(gate.output).toContain(`receipt: the PR body shows the receipt of ${short(head)}, not HEAD`);
  const json = await pr.fleet("gate", "--json");
  expect(json.output).not.toContain("receipt: the PR body shows");
});

test("a publisher handler gets the page, title and previous id, and its link goes into the block and the report", async () => {
  const { pr, head } = await provedPr();
  expect((await pr.fleet("gate")).code).toBe(0);
  expect((await pr.fleet("receipt")).output.split("\n").at(-1)).toBe(`receipt written at ${short(head)}`);
  const handler = publisher(pr);

  handler.failing(true);
  const failed = await pr.fleet("receipt");
  expect(failed.code).toBe(1);
  expect(failed.output).toContain("the receipt server answered 500");
  expect(patches(pr)).toBe(1);

  handler.failing(false);
  pr.githubFault("patch-error", "gh: Server Error (HTTP 502)");
  await expect(pr.fleet("receipt")).rejects.toThrow();
  pr.githubFault("patch-error", undefined);
  expect((await pr.fleet("receipt")).output.split("\n").at(-1)).toBe(`receipt written at ${short(head)}: https://receipts.example/r/receipt-2`);
  const [, published, repaired] = handler.requests();
  expect(published).toMatchObject({ repository: "example/product", pr: 42, title: "Proof receipt: example/product#42" });
  expect(published.previous).toBeUndefined();
  expect(published.page).toContain("| live-run | Sent a test email to the sandbox inbox |");
  expect(repaired.previous).toEqual({ id: "receipt-2", url: "https://receipts.example/r/receipt-2" });
  expect(block(pr.githubBody())).toEndWith("Full receipt: https://receipts.example/r/receipt-2\n<!-- /fleet-proof-receipt -->");
  const report = (await pr.decide("report", "--pr", "example/product#42")).output;
  expect(report).toContain("[receipt](https://receipts.example/r/receipt-2)");

  expect((await pr.fleet("receipt")).output.split("\n").at(-1)).toBe("receipt current");
  expect(handler.requests()).toHaveLength(3);
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent two test emails", "--result", "Both delivered");
  expect((await pr.fleet("receipt")).code).toBe(0);
  expect(handler.requests()).toHaveLength(4);
  expect(block(pr.githubBody())).toContain("| live-run | Sent two test emails | Both delivered |");
  expect(handler.requests().at(-1).previous).toEqual({ id: "receipt-2", url: "https://receipts.example/r/receipt-2" });

  pr.githubComment(7, "the-user", "Proofs at HEAD: live-run passed.", "2026-10-25T12:00:00Z");
  expect((await pr.fleet("receipt", "--comment", "https://github.com/example/product/pull/42#issuecomment-7")).code).toBe(0);
  expect((await pr.decide("report", "--pr", "example/product#42")).output).toContain("issuecomment-7");
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent three test emails", "--result", "All delivered");
  expect((await pr.fleet("receipt")).code).toBe(0);
  expect(handler.requests().at(-1).previous).toEqual({ id: "receipt-2", url: "https://receipts.example/r/receipt-2" });
});

test("a receipt link written on another machine is never turned into a publisher id: the handler publishes a new page", async () => {
  const { pr } = await provedPr();
  expect((await pr.fleet("gate")).code).toBe(0);
  const handler = publisher(pr);
  pr.pullRequestState({ body: `${template}\n<!-- fleet-proof-receipt head=${"a".repeat(40)} hash=01 -->\n## Testing\n\nAn older receipt.\nFull receipt: https://receipts.example/view?receipt=opaque-id\n<!-- /fleet-proof-receipt -->\n` });
  expect((await pr.fleet("receipt")).code).toBe(0);
  expect(handler.requests()[0].previous).toBeUndefined();
  expect(block(pr.githubBody())).toEndWith("Full receipt: https://receipts.example/r/receipt-1\n<!-- /fleet-proof-receipt -->");
});

test("the first receipt written into a body, and each refresh, leave the judge's prompt as it was", async () => {
  const { pr } = await provedPr();
  installRiskSkill(pr);
  const judge = fakeModel(pr, "JUDGE", verdict({ risk: { verdict: "pass", reason: "One text file changes: low, two-way", citations: [] } }));
  for (const body of [template, `${template}\r\n`, template.replace("## Testing\n\nTest rationale: the send path and the settings page.\n\n- [x] I ticked this box\n\n", ""), `Adds the greeting.\n\n## Testing\n`]) {
    pr.pullRequestState({ body });
    expect((await pr.fleet("gate")).code).toBe(0);
    const asked = judge.prompts().length;
    expect((await pr.fleet("receipt")).code).toBe(0);
    expect((await pr.fleet("gate")).code).toBe(0);
    await pr.fleet("save", "--kind", "live-run", "--ran", `Sent a test email ${asked}`, "--result", "Delivered");
    expect((await pr.fleet("receipt")).code).toBe(0);
    expect((await pr.fleet("gate")).code).toBe(0);
    expect(judge.prompts()).toHaveLength(asked);
    expect(judge.prompts().at(-1)).not.toContain("fleet-proof-receipt");
  }
  expect(judge.prompts().length).toBeGreaterThan(1);
});

test("a changed receipt heading moves the receipt to that section and never leaves or drops a heading", async () => {
  const evidence = JSON.stringify({ "pull-requests.receiptHeading": "Evidence" });
  const sections = "Adds the greeting.\n\n### Testing\n\nTest rationale.\n\n### Evidence\n\nA picture.\n";
  const moved = await provedPr();
  moved.pr.pullRequestState({ body: sections });
  expect((await moved.pr.fleet("receipt")).code).toBe(0);
  expect(moved.pr.githubBody().replace(block(moved.pr.githubBody()), "<block>")).toBe("Adds the greeting.\n\n### Testing\n\nTest rationale.\n\n<block>\n\n### Evidence\n\nA picture.\n");
  moved.pr.env.FLEET_SETTINGS = evidence;
  expect((await moved.pr.fleet("receipt")).output).toContain("receipt written");
  expect(moved.pr.githubBody().replace(block(moved.pr.githubBody()), "<block>")).toBe("Adds the greeting.\n\n### Testing\n\nTest rationale.\n\n### Evidence\n\nA picture.\n\n<block>\n");
  expect((await moved.pr.fleet("receipt")).output).toContain("receipt current");

  const generated = await provedPr();
  generated.pr.pullRequestState({ body: "Adds the greeting.\n" });
  expect((await generated.pr.fleet("receipt")).code).toBe(0);
  expect(block(generated.pr.githubBody()).split("\n")[1]).toBe("## Testing");
  generated.pr.env.FLEET_SETTINGS = evidence;
  expect((await generated.pr.fleet("receipt")).output).toContain("receipt written");
  const body = generated.pr.githubBody();
  expect(body.replace(block(body), "<block>")).toBe("Adds the greeting.\n\n<block>\n");
  expect(block(body).split("\n")[1]).toBe("## Evidence");
  expect(body).not.toContain("Testing");
});

test("a body that ends inside an open code fence, HTML block or comment refuses the receipt and stays as it is", async () => {
  const { pr } = await provedPr();
  const old = `<!-- fleet-proof-receipt head=${"a".repeat(40)} hash=01 -->\n| Proof |\n| --- |\n| old |\n<!-- /fleet-proof-receipt -->`;
  for (const body of ["Adds the greeting.\n\n### Testing\n\n```sh\necho ok\n", "Adds the greeting.\n\n### Testing\n\n<pre>\necho ok\n", "Adds the greeting.\n\n<!-- a note that never closes\n", `Adds the greeting.\n\n### Testing\n\n\`\`\`sh\n${old}\n`]) {
    pr.pullRequestState({ body });
    await expect(pr.fleet("receipt")).rejects.toThrow("would not show as a block of its own");
    expect(pr.githubBody()).toBe(body);
  }
  expect(patches(pr)).toBe(0);
});
