import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, graded, hubAt, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const idIn = (output: string) => /\[(d-[0-9a-f]+)\]/.exec(output)![1]!;
const ledgerFile = (pr: Checkout) => join(pr.home, ".local/state/fleet/decisions.jsonl");
const on = (pr: Checkout, day: string, time = "10:00") => { pr.clock.now = new Date(`${day}T${time}:00Z`); };
const decideAlone = (pr: Checkout, decisionClass: string, question: string) => pr.decide("record", "--mark", "🤖", "--class", decisionClass, "--pr", "example/product#42", "--question", question, "--answer", "Go ahead", "--rejected", "Ask the user", "--reason", "Small change");
const reverse = (pr: Checkout, id: string, day: string, words: string, ...more: string[]) => pr.decide("reverse", id, "--words", `${day} "${words}"`, "--thread", "thread-1", ...more);
const lift = (pr: Checkout, decisionClass: string, day: string, words: string) => pr.decide("lift", "--class", decisionClass, "--words", `${day} "${words}"`, "--thread", "thread-1");
const liftQuestion = (decisionClass: string) => `Lift the brake on ${decisionClass} decisions of example/product#42?`;

async function brake(pr: Checkout, decisionClass: string, decided: string, reversed: string) {
  on(pr, decided);
  const ids = [idIn((await decideAlone(pr, decisionClass, `First ${decisionClass} call?`)).output), idIn((await decideAlone(pr, decisionClass, `Second ${decisionClass} call?`)).output)];
  on(pr, reversed);
  for (const [index, id] of ids.entries()) {
    pr.say(`Wrong ${decisionClass} call ${index + 1}`);
    await reverse(pr, id, reversed, `Wrong ${decisionClass} call ${index + 1}`);
  }
  return ids;
}

test("lift hears only a lift or a yes to a question that asks to lift that class's brake, from an answer no decision used", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await brake(pr, "design", "2026-10-10", "2026-10-20");
  on(pr, "2026-10-21");
  const stillBraked = () => expect(decideAlone(pr, "design", "Third design call?")).rejects.toThrow("The design class is braked");

  pr.choose("No, keep the brake", liftQuestion("design"));
  await expect(lift(pr, "design", "2026-10-21", "No, keep the brake")).rejects.toThrow(`The user chose "No, keep the brake", which does not lift the design brake. It stays on`);
  pr.choose("Yes, go on", "Run one more review round? example/product#42: the arbiter escalates.");
  await expect(lift(pr, "design", "2026-10-21", "Yes, go on")).rejects.toThrow("The question the user answered does not ask to lift the design brake. The question: Run one more review round?");
  pr.choose("Yes, lift it", liftQuestion("status"));
  await expect(lift(pr, "design", "2026-10-21", "Yes, lift it")).rejects.toThrow("does not ask to lift the design brake");
  pr.choose("Lift it", liftQuestion("design"));
  const used = idIn((await pr.decide("record", "--mark", "👤", "--class", "design", "--pr", "example/product#42")).output);
  await expect(lift(pr, "design", "2026-10-21", "Lift it")).rejects.toThrow(`That answer is already recorded as decision ${used}`);
  await stillBraked();

  pr.choose("Lift the brake", liftQuestion("design"));
  expect((await lift(pr, "design", "2026-10-21", "Lift the brake")).code).toBe(0);
  expect((await decideAlone(pr, "design", "Third design call?")).code).toBe(0);
});

test("one answer lifts one brake, even when two machines lift two classes with it at once", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  hubAt(pr);
  await brake(pr, "design", "2026-10-10", "2026-10-20");
  await brake(pr, "status", "2026-10-10", "2026-10-20");
  on(pr, "2026-10-21");
  pr.choose("Lift both", "Lift the brake on design and status decisions of example/product#42?");
  const ssh = pr.hub.ssh!;
  let raced = false;
  pr.hub.ssh = async (host, command, stdin) => {
    if (!raced && stdin?.includes('"type":"lift"')) { raced = true; await ssh(host, command, stdin.replace('"class":"design"', '"class":"status"')); }
    return ssh(host, command, stdin);
  };

  await expect(lift(pr, "design", "2026-10-21", "Lift both")).rejects.toThrow("Not lifted: another lift used that answer first, or the brake changed while Fleet recorded it. One answer lifts one brake; ask the user again");
  await expect(decideAlone(pr, "design", "Third design call?")).rejects.toThrow("The design class is braked");
  expect((await decideAlone(pr, "status", "Third status call?")).code).toBe(0);
  await expect(lift(pr, "design", "2026-10-21", "Lift both")).rejects.toThrow("That message already lifted the status brake");
});

test("a lift never clears a brake set after its answer: a stale duplicate or an older answer leaves it on", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await brake(pr, "design", "2026-10-10", "2026-10-20");
  on(pr, "2026-10-21");
  pr.choose("Lift it", liftQuestion("design"));
  expect((await lift(pr, "design", "2026-10-21", "Lift it")).code).toBe(0);
  const liftLine = readFileSync(ledgerFile(pr), "utf8").trim().split("\n").find((line) => line.includes('"type":"lift"'))!;
  await brake(pr, "design", "2026-10-22", "2026-10-25");

  appendFileSync(ledgerFile(pr), liftLine + "\n");
  appendFileSync(ledgerFile(pr), liftLine.replace(/"message":"[^"]+"/, '"message":"request-old:0"').replace(/"at":"[^"]+"/, '"at":"2026-10-23T10:00:00.000Z"') + "\n");
  await expect(decideAlone(pr, "design", "Fifth design call?")).rejects.toThrow("The design class is braked");
});

test("a brake takes the time of the later reversal, even when that reversal is recorded first", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  on(pr, "2026-10-10");
  const first = idIn((await decideAlone(pr, "design", "First design call?")).output);
  const second = idIn((await decideAlone(pr, "design", "Second design call?")).output);
  on(pr, "2026-10-20");
  pr.say("Wrong second call");
  on(pr, "2026-10-20", "12:00");
  pr.choose("Lift it", liftQuestion("design"));
  on(pr, "2026-10-21");
  pr.say("Wrong first call");
  on(pr, "2026-10-25");

  await reverse(pr, first, "2026-10-21", "Wrong first call");
  await reverse(pr, second, "2026-10-20", "Wrong second call");
  await expect(lift(pr, "design", "2026-10-20", "Lift it")).rejects.toThrow(`The user wrote that before the brake, which the reversal of ${first} set on 2026-10-21`);
});

test("a reversal hears the message of the quoted date, and asks for --message when that date holds two", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  on(pr, "2026-09-30");
  const [early, late, third] = [idIn((await decideAlone(pr, "design", "Parser?")).output), idIn((await decideAlone(pr, "design", "Printer?")).output), idIn((await decideAlone(pr, "design", "Report?")).output)];
  on(pr, "2026-10-01");
  pr.say("No");
  on(pr, "2026-10-30");
  pr.say("No");

  expect((await reverse(pr, early, "2026-10-01", "No")).output).toContain("(reversed 2026-10-01 from");
  expect((await reverse(pr, late, "2026-10-30", "No")).output).toContain("(reversed 2026-10-30 from");
  expect((await decideAlone(pr, "design", "Index?")).code).toBe(0);

  on(pr, "2026-10-30", "15:00");
  pr.say("No");
  await expect(reverse(pr, third, "2026-10-30", "No")).rejects.toThrow(`2 messages of the user's in thread thread-1 on 2026-10-30 say "no". Pass --message with the id of the one they meant`);
  await expect(reverse(pr, third, "2026-10-30", "No", "--message", "message-1")).rejects.toThrow(`Message message-1 of the user's in thread thread-1 does not say "no" on 2026-10-30`);
  expect((await reverse(pr, third, "2026-10-30", "No", "--message", "message-3")).code).toBe(0);
  await expect(decideAlone(pr, "design", "Cache?")).rejects.toThrow(`The design class is braked: the user reversed decisions ${late} and ${third}`);
});

test("a reversal needs words the user wrote after the decision", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  on(pr, "2026-10-01");
  pr.say("Wrong call");
  on(pr, "2026-10-25");
  const id = idIn((await decideAlone(pr, "design", "Parser?")).output);

  await expect(reverse(pr, id, "2026-10-01", "Wrong call")).rejects.toThrow(`The user wrote that on 2026-10-01, before decision ${id} was recorded on 2026-10-25. Only their words after it reverse it`);
  expect((await pr.decide("list", "--live")).output).toContain(id);
});

test("only reversals of the agent's decisions count toward a brake", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  on(pr, "2026-10-10");
  const ids: string[] = [];
  for (const question of ["Where does the parser go? example/product#42", "Where does the printer go? example/product#42"]) {
    pr.choose("A new module", question);
    ids.push(idIn((await pr.decide("record", "--mark", "👤", "--class", "design", "--pr", "example/product#42")).output));
  }
  on(pr, "2026-10-20");
  for (const [index, id] of ids.entries()) {
    pr.say(`Use the shared one ${index + 1}`);
    await reverse(pr, id, "2026-10-20", `Use the shared one ${index + 1}`);
  }
  expect((await decideAlone(pr, "design", "Index?")).code).toBe(0);
});

test("a voided decision has nothing to reverse", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  const id = idIn((await decideAlone(pr, "design", "Parser?")).output);
  await pr.decide("void", id, "--reason", "HEAD now splits the parser");
  pr.say("No");

  await expect(reverse(pr, id, "2026-10-25", "No")).rejects.toThrow(`Decision ${id} is voided: HEAD now splits the parser. It counts no more, so there is nothing to reverse`);
});

test("a yes lifts a brake only when the question starts by asking to lift it, and a lift answer lifts in any question that names the brake and the class", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await brake(pr, "design", "2026-10-10", "2026-10-20");
  on(pr, "2026-10-21");

  pr.choose("Yes, keep it", "Keep the brake on design decisions, or lift it?");
  await expect(lift(pr, "design", "2026-10-21", "Yes, keep it")).rejects.toThrow(`The user chose "Yes, keep it" to a question that does not start with "Lift the brake on design". A plain yes lifts only the question that asks it; the brake stays on. The question: Keep the brake on design decisions, or lift it?`);
  await expect(decideAlone(pr, "design", "Third design call?")).rejects.toThrow("The design class is braked");

  pr.choose("Lift it", "Keep the brake on design decisions?");
  expect((await lift(pr, "design", "2026-10-21", "Lift it")).code).toBe(0);
  expect((await decideAlone(pr, "design", "Third design call?")).code).toBe(0);
});

test("one answer either lifts a brake or records a decision, never both, even when both commands run at once", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  hubAt(pr);
  await brake(pr, "design", "2026-10-10", "2026-10-20");
  on(pr, "2026-10-21");
  const recordDesign = (words: string) => pr.decide("record", "--mark", "👤", "--class", "design", "--pr", "example/product#42", "--words", `2026-10-21 "${words}"`);
  const ssh = pr.hub.ssh!;
  const beforeAppend = (type: string, step: () => Promise<unknown>) => {
    let raced = false;
    pr.hub.ssh = async (host, command, stdin) => {
      if (!raced && stdin?.includes(`"type":"${type}"`)) { raced = true; await step(); }
      return ssh(host, command, stdin);
    };
  };

  pr.choose("Lift it", liftQuestion("design"));
  let recorded = "";
  beforeAppend("lift", async () => { recorded = idIn((await recordDesign("Lift it")).output); });
  const refused = await lift(pr, "design", "2026-10-21", "Lift it").then(() => "lifted", (error: Error) => error.message);
  expect(refused).toBe(`Not lifted: decision ${recorded} used that answer first. One answer lifts one brake or records one decision; ask the user again`);
  await expect(decideAlone(pr, "design", "Third design call?")).rejects.toThrow("The design class is braked");

  pr.choose("Lift the brake", liftQuestion("design"));
  beforeAppend("decide", () => lift(pr, "design", "2026-10-21", "Lift the brake"));
  await expect(recordDesign("Lift the brake")).rejects.toThrow("That answer already lifted the design brake on 2026-10-21");
  expect((await decideAlone(pr, "design", "Third design call?")).code).toBe(0);
  pr.hub.ssh = ssh;
  await expect(recordDesign("Lift the brake")).rejects.toThrow("That answer already lifted the design brake on 2026-10-21");
  expect((await pr.decide("list", "--class", "design")).output).not.toContain(`2026-10-21 "Lift the brake"`);
});

test("fleet proof receipt records only a comment on the PR it names", async () => {
  const pr = await checkout();
  pr.githubComment(11, "the-user", "Proofs at HEAD: live-run passed.", "2026-10-25T13:00:00Z");
  pr.githubComment(12, "the-user", "Proofs at HEAD: live-run passed.", "2026-10-25T13:00:00Z", 43);
  await expect(pr.fleet("receipt", "--comment", "https://github.com/example/product/pull/43#issuecomment-12")).rejects.toThrow("The comment https://github.com/example/product/pull/43#issuecomment-12 is on example/product#43, not on example/product#42");
  expect((await pr.fleet("receipt", "--comment", "https://github.com/example/product/pull/42#issuecomment-11")).output).toBe("receipt: https://github.com/example/product/pull/42#issuecomment-11");
});
test("one answer of the user's reverses one decision, and an answer already recorded as a decision reverses none", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  on(pr, "2026-10-20");
  const first = idIn((await decideAlone(pr, "design", "First design call?")).output);
  const second = idIn((await decideAlone(pr, "design", "Second design call?")).output);
  on(pr, "2026-10-21");
  pr.say("Undo that one");
  expect((await reverse(pr, first, "2026-10-21", "Undo that one")).code).toBe(0);
  await expect(reverse(pr, second, "2026-10-21", "Undo that one")).rejects.toThrow(`That answer already reversed decision ${first}. One answer reverses one decision; ask the user about this one`);
  const aboutSecond = () => readFileSync(ledgerFile(pr), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.id === second);
  expect(aboutSecond()).toEqual([]);
  pr.choose("Use the shared parser", "Where does the parser of example/product#42 go?");
  const recorded = idIn((await pr.decide("record", "--mark", "👤", "--class", "design", "--pr", "example/product#42")).output);
  await expect(reverse(pr, second, "2026-10-21", "Use the shared parser")).rejects.toThrow(`That answer is already recorded as decision ${recorded}`);
  expect(aboutSecond()).toEqual([]);
  expect((await pr.decide("list", "--live")).output).toContain(second);
  expect((await decideAlone(pr, "design", "Third design call?")).code).toBe(0);
});

test("when two machines reverse two decisions with one answer at once, the one that loses writes no void for older readers", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  hubAt(pr);
  on(pr, "2026-10-20");
  const first = idIn((await decideAlone(pr, "design", "First design call?")).output);
  const second = idIn((await decideAlone(pr, "design", "Second design call?")).output);
  on(pr, "2026-10-21");
  pr.say("Undo that one");
  const ssh = pr.hub.ssh!;
  let raced = false;
  pr.hub.ssh = async (host, command, stdin) => {
    if (!raced && stdin?.includes('"type":"reverse"')) { raced = true; await ssh(host, command, stdin.replaceAll(second, first)); }
    return ssh(host, command, stdin);
  };

  await expect(reverse(pr, second, "2026-10-21", "Undo that one")).rejects.toThrow(`Not reversed: That answer already reversed decision ${first}`);
  const events = readFileSync(join(pr.home, "hub-home/.local/state/fleet/decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events.filter((event) => event.type === "void" && event.id === second)).toEqual([]);
  expect((await pr.decide("list", "--live")).output).toContain(second);
});

test("a reversal that another machine wrote with an answer already used counts no more, and neither does its void", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  on(pr, "2026-10-20");
  const first = idIn((await decideAlone(pr, "design", "First design call?")).output);
  const second = idIn((await decideAlone(pr, "design", "Second design call?")).output);
  on(pr, "2026-10-21");
  pr.say("Undo that one");
  await reverse(pr, first, "2026-10-21", "Undo that one");
  const reversal = readFileSync(ledgerFile(pr), "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "reverse");
  const at = "2026-10-21T10:05:00.000Z";
  appendFileSync(ledgerFile(pr), `${JSON.stringify({ ...reversal, id: second, machine: "other-machine", at })}\n${JSON.stringify({ type: "void", id: second, reason: 'reversed by the user: 2026-10-21 "Undo that one"', at })}\n`);

  expect((await pr.decide("list", "--live")).output).toContain(second);
  expect((await decideAlone(pr, "design", "Third design call?")).code).toBe(0);
});
