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

async function provedPr(review: (pr: Checkout) => Promise<unknown> = reviewHead) {
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
  await review(pr);
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
    ["two template comments before the receipt", "<!-- a template note -->\n<!-- another note -->\n\nMore rationale.", "### Screenshots\n\nA picture."],
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
  const details = "Adds the greeting.\n\n<details>\n<summary>More</summary>\n\nHidden detail.\n\n</details>";
  const { pr } = await provedPr();
  pr.pullRequestState({ body: `${details}\n<!-- fleet-proof-receipt head=${"a".repeat(40)} hash=01 -->\n## Testing\n\n| Proof |\n| --- |\n| old |\n<!-- /fleet-proof-receipt -->\n` });
  expect((await pr.fleet("receipt")).code).toBe(0);
  expect(pr.githubBody().replace(block(pr.githubBody()), "<block>")).toBe(`${details}\n\n<block>\n`);
  expect(block(pr.githubBody()).split("\n")[1]).toBe("## Testing");
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
    ["Sent \u0664\u0668\u066c\u0662\u0661\u0663 emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48\u066c213 emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent 48\u060c213 emails", "Delivered", `the what ran of live-run ${looksLike}`],
    ["Sent emails", "\u0661\u0662\u066a bounced", `the result of live-run ${looksLike}`],
    ["Sent emails", "12\u0609 bounced", `the result of live-run ${looksLike}`],
    ["Sent emails", "12 pct bounced", `the result of live-run ${looksLike}`],
    ["Ran on \u0968 hosts", "Delivered", `the what ran of live-run ${looksLike}`],
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
  expect(published.page).toContain("**What ran:** Sent a test email to the sandbox inbox. **Result:** Delivered in one attempt.");
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

const heavy = (repeats: number) => `é"\\`.repeat(repeats);
const pageOf = (handler: ReturnType<typeof publisher>) => handler.requests().at(-1).page as string;

const lensAnswer = (finding = "Retries twice -> a second email") => `FINDINGS:\n- feature.txt:1 | major | Correctness | ${finding} | retry once | sites: feature.txt:1 | anchor: greet new members by name\nCOVERED: feature.txt\n`;

function panelRound({ answer, minutes = 4.5 }: { answer?: string; minutes?: number } = {}) {
  return async (pr: Checkout) => {
    fakeModel(pr, "REVIEWER", answer ?? lensAnswer());
    pr.env.FLEET_PROOF_REVIEWER_MODEL = "gpt-6.1-sol";
    const start = pr.clock.now.getTime();
    let reads = 0;
    Object.defineProperty(pr.clock, "now", { get: () => new Date(start + reads++ * minutes * 60_000), configurable: true });
    await pr.fleet("review", "--lens", "correctness", "--lens", "fresh-eyes");
    expect((await pr.fleet("review", "--wait")).code).toBe(0);
    Object.defineProperty(pr.clock, "now", { value: new Date(start), writable: true, configurable: true, enumerable: true });
    writeFileSync(join(pr.repository, "responses.md"), "1. fixed: one retry\n2. rejected: the domain term\n");
    expect((await pr.fleet("respond", "--round", "1", "responses.md")).code).toBe(0);
  };
}

async function pagePr(options: Parameters<typeof panelRound>[0] = {}) {
  const proved = await provedPr(panelRound(options));
  const { pr, file } = proved;
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent a test email to the sandbox inbox", "--result", "Delivered in one attempt", file("run.log", "delivered\n"),
    file("mailbox.md", "The sandbox inbox shows the email.\n\n```\n$ curl -s https://sandbox.example/messages\n{\"count\": 1}\n```\n$ bun run status\nexit=0\nThe status API reads delivered.\n"));
  fakeModel(pr, "JUDGE", verdict());
  expect((await pr.fleet("gate")).code).toBe(0);
  return { ...proved, handler: publisher(pr) };
}

test("the full receipt holds the header and its parts in order, and the body section links it", async () => {
  const { pr, older, head, handler } = await pagePr();
  expect((await pr.fleet("receipt", "--not-checked", "Safari")).code).toBe(0);
  const page = pageOf(handler);
  expect(page.match(/^## .+$/gm)).toEqual([
    "## Proof by commit", "## Review rounds", "## Judge verdicts", "## Gaps and who accepted them", "## Screenshots in journey order",
    "## Live run", "## UI walk", "## Production shape", "## Decisions", "## Not checked",
  ]);
  expect(page).toStartWith("# Proof receipt: example/product#42\n\n[example/product#42](https://github.com/example/product/pull/42): Greet new members\n\n");
  for (const line of [
    `**HEAD:** \`${short(head)}\``, "**Owed:** live-run, ui-walk, prod-shape, cross-version", "**Judge at HEAD:** ✅ passed (",
    "| Commit | live-run | ui-walk | prod-shape | cross-version | Review | Judge |",
    `| \`${short(older)}\` | | saved | | | | |`,
    `| \`${short(head)}\` | saved | reused from \`${short(older)}\` | saved | gap | round 1 | ✅ |`,
    `- \`${short(head)}\` ui-walk reused from \`${short(older)}\`: Only the greeting text changed since`,
    "| Correctness | gpt-6.1-sol | 4 min 30 s | 1 |",
    "| Fresh eyes | gpt-6.1-sol | 4 min 30 s | 1 |",
    "| 1 | major | Correctness | `feature.txt:1` | Retries twice -> a second email \\| retry once \\| sites: feature.txt:1 \\| anchor: greet new members by name | fixed: one retry |",
    "<summary>Raw answer of the Correctness lens, by gpt-6.1-sol</summary>",
    "| pass | pass | pass | | pass | ✅ |",
    "judge proof: pass:",
    `| cross-version | \`${short(head)}\` | The old client is retired |`, "| 👤 the user |",
    `1. The sender settings page after the save (not published) at \`${short(older)}\`, evidence`,
    "**What ran:** Sent a test email to the sandbox inbox. **Result:** Delivered in one attempt.",
    "**What ran:** Walked the sender settings page. **Result:** The new sender shows after a reload.",
    "The sandbox inbox shows the email.", "The status API reads delivered.", "[6 lines of command output left out]",
    "Read 48,213 stored senders.",
    "- Safari",
  ]) expect(page).toContain(line);
  expect(page).toMatch(/^- 👤 \*\*.+\(the user, proof-gap, /m);
  for (const output of ["curl", "\"count\"", "bun run status", "exit=0"]) expect(page).not.toContain(output);
  expect(block(pr.githubBody())).toContain("Full receipt: https://receipts.example/r/receipt-1\n<!-- /fleet-proof-receipt -->");
});

test("a new decision publishes the page again under the same id, and an unchanged page is current", async () => {
  const { pr, handler } = await pagePr();
  expect((await pr.fleet("receipt")).code).toBe(0);
  expect((await pr.fleet("receipt")).output.split("\n").at(-1)).toBe("receipt current");
  expect(handler.requests()).toHaveLength(1);
  await pr.decide("record", "--mark", "🤖", "--class", "design", "--pr", "example/product#42", "--question", "Retry once here?", "--answer", "Yes, in this PR", "--rejected", "A follow-up", "--reason", "Small change");
  expect((await pr.fleet("receipt")).code).toBe(0);
  expect(handler.requests()).toHaveLength(2);
  expect(pageOf(handler)).toMatch(/^- 🤖 \*\*Retry once here\?\*\* Yes, in this PR/m);
  expect(handler.requests().at(-1).previous).toEqual({ id: "receipt-1", url: "https://receipts.example/r/receipt-1" });
});

test("the page headline says the judge has not run at HEAD once evidence changes after the gate", async () => {
  const { pr, file, handler } = await pagePr();
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent two test emails", "--result", "Both delivered", file("again.log", "delivered twice\n"));
  expect((await pr.fleet("receipt")).code).toBe(0);
  expect(pageOf(handler)).toContain("**Judge at HEAD:** not yet run");
  expect(pageOf(handler)).toContain("| 1 | `");
});

async function localPr() {
  const { pr, file } = await provedPr(async (pr) => { await reviewHead(pr); });
  return { pr, file, local: join(pr.pullRequest, "display", "receipt.md") };
}

test("without a publisher the page goes to a local file, its path is printed, the body has no link, and the report links the PR", async () => {
  const { pr, local } = await localPr();
  const written = await pr.fleet("receipt");
  expect(written.code).toBe(0);
  expect(/^receipt page: (\S+)$/m.exec(written.output)?.[1]).toBe(local);
  const page = readFileSync(local, "utf8");
  expect(page.match(/^## .+$/gm)).toEqual(["## Proof by commit", "## Review rounds", "## Judge verdicts", "## Gaps and who accepted them", "## Screenshots in journey order", "## Live run", "## UI walk", "## Production shape", "## Decisions"]);
  expect(page).toContain("> No judge run is stored at HEAD");
  expect(block(pr.githubBody())).not.toContain("Full receipt");
  expect((await pr.decide("report", "--pr", "example/product#42")).output).toContain("[receipt](https://github.com/example/product/pull/42)");
});

test("a lost local page is written again while the body stays current", async () => {
  const { pr, local } = await localPr();
  expect((await pr.fleet("receipt")).code).toBe(0);
  const page = readFileSync(local, "utf8");
  rmSync(local);
  const restored = await pr.fleet("receipt");
  expect(restored.output.split("\n").slice(-2)).toEqual([`receipt page: ${local}`, "receipt current"]);
  expect(readFileSync(local, "utf8")).toBe(page);
});

test("a local page over the publisher's budget is kept whole", async () => {
  const { pr, file, local } = await localPr();
  const wide = Array.from({ length: 40 }, (_, index) => `Wide line ${index + 1}: ${heavy(10_000)}`).join("\n");
  await pr.fleet("save", "--kind", "live-run", "--ran", "Walked the mailbox", "--result", "Every message arrived", file("wide.md", wide));
  expect((await pr.fleet("receipt")).code).toBe(0);
  const full = readFileSync(local, "utf8");
  expect(full).toContain("Wide line 40:");
  expect(full).not.toContain("Left out to fit the page");
});

test("commits are listed in the order they were proved or reviewed, HEAD last", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: template });
  const reviewed: string[] = [];
  for (const [round, text] of ["greet", "greet them", "greet them all", "greet them all by name"].entries()) {
    reviewed.push(await pr.commit("feature.txt", `${text}\n`));
    if (round === 0) await reviewHead(pr); else await reviewAgain(pr, round + 1);
  }
  const head = await pr.commit("feature.txt", "greet them all by first name\n");
  await pr.fleet("require", "--kinds", "live-run");
  writeFileSync(join(pr.repository, "run.log"), "delivered\n");
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent a test email", "--result", "Delivered", "run.log");
  expect((await pr.fleet("receipt")).code).toBe(0);
  const rows = readFileSync(join(pr.pullRequest, "display", "receipt.md"), "utf8").split("\n").filter((line) => /^\| `[0-9a-f]{7}` \|/.test(line));
  expect(rows.map((line) => line.slice(3, 10))).toEqual([...reviewed, head].map(short));
});

test("evidence reused and then carried across a base merge shows the lines and notes of the commit that ran it", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  pr.pullRequestState({ body: "Adds the greeting." });
  await reviewHead(pr);
  await pr.fleet("require", "--kinds", "live-run");
  writeFileSync(join(pr.repository, "run.log"), "delivered\n");
  writeFileSync(join(pr.repository, "mailbox.md"), "The inbox shows the email.\n");
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent a test email", "--result", "Delivered", "run.log", "mailbox.md");
  const ran = await pr.git("rev-parse", "HEAD");
  const reused = await pr.commit("feature.txt", "greet by name\n");
  await pr.fleet("save", "--kind", "live-run", "--reuse-from", ran, "--reason", "Only the greeting text changed");
  await pr.advanceBase("base.txt", "base\n");
  await pr.git("merge", "-q", "--no-edit", "origin/main");
  const merge = await pr.git("rev-parse", "HEAD");
  expect((await pr.fleet("receipt")).code).toBe(0);
  const page = readFileSync(join(pr.pullRequest, "display", "receipt.md"), "utf8");
  expect(page).toContain(`| \`${short(merge)}\` | carried from \`${short(reused)}\` | | |`);
  expect(page).toContain("**What ran:** Sent a test email. **Result:** Delivered.");
  expect(page).toContain(`at \`${short(ran)}\`\n\nThe inbox shows the email.`);
});

test("a page over the byte budget drops raw lens answers, then judge reasons, then long notes, each with a notice, then refuses", async () => {
  const lens = await pagePr({ answer: `${lensAnswer()}\n${heavy(250_000)}\n` });
  expect((await lens.pr.fleet("receipt")).code).toBe(0);
  const lean = pageOf(lens.handler);
  expect(lean).toContain("> Left out to fit the page: raw lens answers.");
  expect(lean).not.toContain("> Left out to fit the page: judge reasons.");
  expect(Buffer.byteLength(JSON.stringify(lens.handler.requests()[0]))).toBeLessThan(900_000);

  const long = Array.from({ length: 600 }, (_, index) => `Line ${index + 1} of the mailbox walk: ${heavy(400)}`).join("\n");
  await lens.pr.fleet("save", "--kind", "live-run", "--ran", "Walked the mailbox", "--result", "Every message arrived", lens.file("walk.md", long));
  expect((await lens.pr.fleet("receipt")).code).toBe(0);
  const cut = pageOf(lens.handler);
  const notices = ["raw lens answers", "judge reasons", "evidence notes past their first 40 lines"].map((part) => cut.indexOf(`> Left out to fit the page: ${part}.`));
  expect(notices.every((index) => index >= 0)).toBe(true);
  expect(notices).toEqual([...notices].sort((a, b) => a - b));
  expect(cut).toContain("Line 40 of the mailbox walk");
  expect(cut).not.toContain("Line 41 of the mailbox walk");

  const wide = Array.from({ length: 40 }, () => heavy(10_000)).join("\n");
  await lens.pr.fleet("save", "--kind", "live-run", "--ran", "Walked the mailbox", "--result", "Every message arrived", lens.file("wide.md", wide));
  const calls = lens.handler.requests().length;
  const patched = patches(lens.pr);
  const over = await lens.pr.fleet("receipt");
  expect(over.code).toBe(1);
  expect(over.output.split("\n").at(-1)).toStartWith("receipt refused: the full receipt is ");
  expect(lens.handler.requests()).toHaveLength(calls);
  expect(patches(lens.pr)).toBe(patched);
});

test("stored text stays text on the page: command output in lists and quotes is left out, tags show as text, and a backtick run cannot close its fence", async () => {
  const { pr, handler, file } = await pagePr({ answer: lensAnswer("</td></tr></table><h1>FAKE PASS</h1>").replace("COVERED", "````\nCOVERED") });
  const note = ["Before the list.", "", "- The transcript:", "", "    ```sh", "    $ curl https://sandbox.example", "    TOKEN=private-value", "    ```", "",
    "> ~~~", "> $ bun run status", "> SECRET=quoted-value", "> ~~~", "", "> exit=0", "After the quote.", "", "1. ```sh", "   LISTED=list-value", "   ```", "After the listed fence.", "<details open><summary>ALL PASS</summary></details>", "",
    "# Mailbox check", "", "    INDENTED=code-value", "", "## Result", "", "$ bun run check", "UNFENCED=output-value", "exit=0", "After the transcript.", "", "$ bun run probe", "```", "FENCED=probe-value", "exit=0", "```", "After the fenced transcript."].join("\n");
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent a test email", "--result", "Delivered", file("nested.md", note));
  for (const hour of ["13", "14"]) {
    pr.clock.now = new Date(`2026-10-25T${hour}:00:00Z`);
    await pr.fleet("save", "--kind", "live-run", "--ran", "Sent a test email", "--result", "Delivered", file(`run-${hour}.log`, `delivered at ${hour}\n`));
    expect((await pr.fleet("gate")).code).toBe(0);
  }
  expect((await pr.fleet("receipt")).code).toBe(0);
  const page = pageOf(handler);
  expect([...page.matchAll(/^\| (\d) \| `[0-9a-f]{7}` \| [^|]+ \| 2026-10-25 (\d\d):00 UTC \|/gm)].map((match) => `${match[1]} ${match[2]}`)).toEqual(["1 12", "2 13", "3 14"]);
  for (const kept of ["Before the list.", "After the quote.", "After the listed fence.", "**Mailbox check**", "**Result**", "After the transcript.", "After the fenced transcript.", "&lt;/td>&lt;/tr>&lt;/table>&lt;h1>FAKE PASS&lt;/h1>", "&lt;details open>&lt;summary>ALL PASS&lt;/summary>&lt;/details>"]) expect(page).toContain(kept);
  const shown = page.replace(/<details>\n<summary>Raw answer[\s\S]*?<\/details>/g, "");
  for (const output of ["curl", "TOKEN=private-value", "LISTED=list-value", "bun run status", "SECRET=quoted-value", "exit=0", "<h1>", "<details open>", "INDENTED=code-value", "UNFENCED=output-value", "bun run check", "FENCED=probe-value", "bun run probe", "# Mailbox check", "## Result"]) expect(shown).not.toContain(output);
  const raw = /<summary>Raw answer of the Correctness lens, by gpt-6\.1-sol<\/summary>\n\n(`+)text\n/.exec(page);
  expect(raw?.[1]).toBe("`````");
});

test("a single reviewer's findings show their bold severity and backtick location in their own columns", async () => {
  const { pr, file } = await provedPr(async (pr) => {
    expect((await pr.fleet("review-start", "--scope", "full")).code).toBe(0);
    writeFileSync(join(pr.repository, "findings.md"), "- **high**, `feature.txt:1`: Retries twice.\n- **low** — `feature.txt:2`: The name is unclear.\n- A finding without a severity.\n- `bun test feature.test.ts`: 100 passed.\n");
    expect((await pr.fleet("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
    writeFileSync(join(pr.repository, "responses.md"), "1. fixed: one retry\n2. rejected: the domain term\n3. rejected: not a bug\n4. rejected: a note, not a finding\n");
    expect((await pr.fleet("respond", "--round", "1", "responses.md")).code).toBe(0);
  });
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent a test email", "--result", "Delivered", file("run.log", "delivered\n"));
  const handler = publisher(pr);
  expect((await pr.fleet("receipt")).code).toBe(0);
  const rows = pageOf(handler).split("\n").filter((line) => /^\| [1-4] \| /.test(line));
  expect(rows).toEqual([
    "| 1 | high | | `feature.txt:1` | Retries twice. | fixed: one retry |",
    "| 2 | low | | `feature.txt:2` | The name is unclear. | rejected: the domain term |",
    "| 3 | | | | A finding without a severity. | rejected: not a bug |",
    "| 4 | | | | `bun test feature.test.ts`: 100 passed. | rejected: a note, not a finding |",
  ]);
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

test("a receipt between two ordered lists refreshes where it is and keeps both lists", async () => {
  const { pr } = await provedPr();
  const old = `<!-- fleet-proof-receipt head=${"a".repeat(40)} hash=01 -->\n| Proof |\n| --- |\n| old |\n<!-- /fleet-proof-receipt -->`;
  const body = `Adds the greeting.\n\n### Testing\n\n1. First\n\n${old}\n\n7. Seventh\n`;
  pr.pullRequestState({ body });
  expect((await pr.fleet("receipt")).code).toBe(0);
  expect(pr.githubBody().replace(block(pr.githubBody()), "<block>")).toBe(body.replace(old, "<block>"));
  expect(Bun.markdown.html(pr.githubBody())).toContain('<ol start="7">');
});

test("a changed receipt heading refreshes the receipt where it is when moving it would join the lists or code blocks around it", async () => {
  const { pr } = await provedPr();
  pr.env.FLEET_SETTINGS = JSON.stringify({ "pull-requests.receiptHeading": "Evidence" });
  const old = (heading: string) => `<!-- fleet-proof-receipt head=${"a".repeat(40)} hash=01 -->\n${heading}| Proof |\n| --- |\n| old |\n<!-- /fleet-proof-receipt -->`;
  const cases = [["1. First", "7. Seventh", "<ol"], ["- one", "- two", "<ul"], ["    one", "    two", "<pre>"]] as const;
  for (const [first, last, tag] of cases) for (const [heading, shown] of [["## Testing\n\n", "## Evidence"], ["", "| Proof | What ran | Result | Commit |"]] as const) {
    const body = `Adds the greeting.\n\n### Testing\n\n${first}\n\n${old(heading)}\n\n${last}\n\n### Evidence\n\nA picture.\n`;
    pr.pullRequestState({ body });
    expect((await pr.fleet("receipt")).output).toContain("receipt written");
    const written = pr.githubBody();
    expect(written.replace(block(written), "<block>")).toBe(body.replace(old(heading), "<block>"));
    expect(block(written).split("\n")[1]).toBe(shown);
    expect(Bun.markdown.html(written).split(tag).length - 1).toBe(2);
    expect((await pr.fleet("receipt")).output).toContain("receipt current");
  }
});

test("code is left out of the page where the parser puts it, indented or fenced, whatever a line starts with, while prose that repeats a code line, nested lists and lazy lines stay", async () => {
  const { pr, handler, file } = await pagePr();
  const note = ["Before the code.", "", "    - TOP=list-marker", "    1. NUMBERED=list-marker", "", "> A quote.", ">", ">     - QUOTED=quoted-code", "", "- An item.", "", "        - ITEM=item-code", "",
    "Tabbed:", "", "\t* TABBED=tab-code", "", "| Step | Result |", "| --- | --- |", "    TABLED=after-table", "", "-     FIRST=item-first", "", "- Outer item.", "", "    - Nested item stays.", "", "A paragraph", "    - lazy line stays.", "", "The inbox shows it.", "", "    The inbox shows it.", "", "- A step", "    The inbox shows it.", "", "```sh", "- ```", "FENCED_LIST=after-list-fence", "> ```", "FENCED_QUOTE=after-quote-fence", "```", "After the fence.", "", "> ~~~", "> QUOTED_FENCE=in-quoted-fence", "> ~~~", "> After the quoted fence.", "", "    CR_FIRST=one\r    CR_SECOND=two\rA line after a carriage return stays.", "", "- A table item.", "", "    | Step | Result |", "    | --- | --- |", "          TABLE_CODE=in-item", "", "- A bare heading item.", "", "    #", "          HEADED=after-bare-heading", "", "- A bare marker item.", "", "    +", "          MARKED=after-bare-marker", "", "- [ ]", "  1. A task step.", "", "      TASKED=after-task-box", "", "Delimiters:", "", "    DELIMITED=\uE001\uE000value", "", "After the code."].join("\r\n");
  await pr.fleet("save", "--kind", "live-run", "--ran", "Sent a test email", "--result", "Delivered", file("indented.md", note));
  expect((await pr.fleet("gate")).code).toBe(0);
  expect((await pr.fleet("receipt")).code).toBe(0);
  const page = pageOf(handler);
  expect(page.split("The inbox shows it.").length - 1).toBe(2);
  expect(page.slice(page.indexOf("Before the code."), page.indexOf("After the code."))).not.toMatch(/```|~~~/);
  for (const kept of ["Before the code.", "A quote.", "An item.", "Tabbed:", "| Step | Result |", "Outer item.", "Nested item stays.", "lazy line stays.", "A line after a carriage return stays.", "A table item.", "A task step.", "After the fence.", "After the quoted fence.", "After the code."]) expect(page).toContain(kept);
  for (const output of ["TOP=", "NUMBERED=", "QUOTED=", "ITEM=", "TABBED=", "TABLED=", "FIRST=", "CR_FIRST=", "CR_SECOND=", "TABLE_CODE=", "HEADED=", "MARKED=", "TASKED=", "DELIMITED=", "FENCED_LIST=", "FENCED_QUOTE=", "QUOTED_FENCE="]) expect(page).not.toContain(output);
});
