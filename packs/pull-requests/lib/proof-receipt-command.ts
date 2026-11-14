import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringSetting } from "../../base/lib/settings.ts";
import { covers, hubLedger } from "./decision-ledger.ts";
import { readPullRequest, type PullRequest } from "./pr-ci.ts";
import { prDirectory, readDecisions, readJson, reviewRecords, writeJson, type ProofIdentity } from "./proof.ts";
import { readDisplay, readNotChecked, recordNotChecked } from "./proof-display.ts";
import { receiptSummary, type GateContext } from "./proof-gate.ts";
import { readPlan } from "./proof-panel.ts";
import { checkMarkers, GuardRefusal, placeReceipt, receiptHash, receiptLink, receiptMarker, renderSection, screenshotFiles, withLink, type ReceiptReview } from "./proof-receipt.ts";
import { handlerPublisher, type Published } from "./proof-receipt-publisher.ts";
import { reviewDisplay } from "./proof-review-display.ts";

export type ReceiptContext = GateContext & { print: (text: string) => void };

const short = (commit: string) => commit.slice(0, 7);
const publishedPath = (home: string, head: ProofIdentity) => join(prDirectory(home, head), "receipt.json");

async function storedArtifact(home: string, head: ProofIdentity) {
  const stored = await readJson<{ url?: unknown; id?: unknown } | undefined>(publishedPath(home, head), undefined);
  return typeof stored?.id === "string" && typeof stored.url === "string" ? { id: stored.id, url: stored.url } : undefined;
}

function readBody(head: ProofIdentity, context: ReceiptContext) {
  const pull = readPullRequest(head, context.run);
  if (!pull.body.trim()) throw new Error(`The body of ${head.repository}#${head.pr} read empty. fleet never writes over a body it could not read: retry, or add text to the body first`);
  return pull;
}

async function writeBody(head: ProofIdentity, body: string, context: ReceiptContext) {
  const directory = await mkdtemp(join(tmpdir(), "fleet-receipt-"));
  try {
    const input = join(directory, "body.json");
    await writeFile(input, JSON.stringify({ body }), { mode: 0o600 });
    const result = context.run(["gh", "api", `repos/${head.repository}/pulls/${head.pr}`, "--method", "PATCH", "--input", input]);
    if (result.code !== 0) throw new Error(`GitHub refused the body write of ${head.repository}#${head.pr} (${result.stderr.trim().split("\n")[0] || `exit ${result.code}`}). Run the receipt again`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function receiptReviews(head: ProofIdentity, home: string): Promise<ReceiptReview[]> {
  return Promise.all(reviewDisplay(await reviewRecords(home, head)).map(async (review) => {
    const plan = await readPlan(review.directory);
    return plan?.lenses.length ? { ...review, lenses: plan.lenses.map((lens) => lens.model) } : review;
  }));
}

export async function runReceipt(head: ProofIdentity, items: string[] | undefined, context: ReceiptContext) {
  const { home, env, print, ssh } = context;
  const first: PullRequest = readBody(head, context);
  if (first.head !== head.commit) throw new Error(`${short(head.commit)} is not the PR's head on GitHub (${short(first.head) || "none"}); push it, then run the receipt again`);
  const ledger = hubLedger(home, env, ssh);
  const decisions = await readDecisions(ledger);
  if (!Array.isArray(decisions)) { print(`receipt: the hub ledger cannot be reached (${decisions.unreachable}); nothing written`); return 3; }
  checkMarkers(first.body);
  const summary = await receiptSummary(head, first, ledger, context);
  const display = await readDisplay(home, head);
  const notChecked = items ?? await readNotChecked(home, head);
  let rendered: ReturnType<typeof renderSection>;
  try {
    rendered = renderSection({ summary, decisions: decisions.filter((decision) => covers(decision, head)), display, notChecked, reviews: await receiptReviews(head, home), screenshots: await screenshotFiles(summary) });
  } catch (error) { if (error instanceof GuardRefusal) { print(error.message); return 2; } throw error; }
  for (const warning of rendered.warnings) print(warning);
  const title = `Proof receipt: ${head.repository}#${head.pr}`;
  const page = `# ${title}\n\n${rendered.section}\n`;
  const hash = receiptHash(rendered.section, page);
  const publish = handlerPublisher(env);
  const link = receiptLink(first.body);
  const previous = await storedArtifact(home, head) ?? link;
  const live = receiptMarker(first.body);
  if (live?.head === head.commit && live.hash === hash && (!publish || (link && link.url === previous?.url))) {
    if (items) await recordNotChecked(home, head, items);
    print("receipt current");
    return 0;
  }
  let published: Published | undefined;
  if (publish) {
    try { published = await publish({ repository: head.repository, pr: head.pr, title, page, ...previous ? { previous } : {} }); }
    catch (error) { print((error as Error).message); return 1; }
    await writeJson(publishedPath(home, head), published);
  }
  const intended = placeReceipt(first.body, { head: head.commit, hash, section: published ? withLink(rendered.section, published.url) : rendered.section }, stringSetting("pull-requests.receiptHeading", env));
  if (readBody(head, context).body !== first.body) throw new Error("The PR body changed while fleet built the receipt. Run the receipt again");
  await writeBody(head, intended, context);
  if (readBody(head, context).body !== intended) throw new Error("The PR body reads back different from the one fleet wrote. Check the body by hand, then run the receipt again");
  if (items) await recordNotChecked(home, head, items);
  print(`receipt written at ${short(head.commit)}${published ? `: ${published.url}` : ""}`);
  return 0;
}
