import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { laneSecretLines } from "./secret-lane-source.ts";
import { eventLogPath, valuesDir } from "./secret-store.ts";
import { fleet, removeHomes, run, sendKey, values } from "./secret-testing.ts";

afterEach(removeHomes);

const laneA = "example/tickets#401";
const laneB = "example/tickets#402";
const laneValue = () => { const value = `lane-${crypto.randomUUID()}`; values.push(value); return value; };
const lanePut = (machine: ReturnType<typeof fleet>, name: string, value: string, ...options: string[]) =>
  machine.dev("put", name, "--file", machine.secretFile(machine.devHome, `${value}\n`), ...options);
const valueFiles = (home: string) => existsSync(valuesDir(home)) ? readdirSync(valuesDir(home)).sort() : [];
const putIds = (home: string, name: string) => readFileSync(eventLogPath(home), "utf8").split("\n").filter((line) => line.includes('"type":"put"')).map((line) => JSON.parse(line) as { id: string; name: string }).filter((put) => put.name === name).map((put) => put.id);

test("a lane put is delivered under its one variable and redacted; its flags and names are checked", async () => {
  const machine = fleet();
  const value = laneValue();
  expect(await lanePut(machine, "stripe-test", value, "--lane", laneA, "--env", "STRIPE_KEY", "--why", "intake", "--expires", "2026-11-18")).toBe(0);
  expect(machine.printed.at(-1)).toContain(`for lane ${laneA}; store expiry 2026-11-18.`);
  const shown = await run(machine.dev, machine.printed, ["stripe-test"], `[ "$STRIPE_KEY" = "${value}" ] && echo "key $STRIPE_KEY"`);
  expect(shown.text).toBe("key [redacted stripe-test]\n");
  expect(await lanePut(machine, "other-test", laneValue(), "--lane", laneA, "--env", "OTHER_KEY", "--expires", "2026-11-18")).toBe(2);
  expect(await lanePut(machine, "other-test", laneValue(), "--lane", laneA, "--why", "intake", "--expires", "2026-11-18")).toBe(2);
  expect(await lanePut(machine, "other-test", laneValue(), "--lane", laneA, "--env", "OTHER_KEY", "--why", "intake")).toBe(2);
  expect(await lanePut(machine, "other-test", laneValue(), "--env", "OTHER_KEY", "--revoke", "https://example.com/keys")).toBe(2);
  expect(await lanePut(machine, "other-test", laneValue(), "--lane", laneA, "--env", "OTHER_KEY", "--why", "intake", "--expires", "2026-11-21")).toBe(1);
  expect(machine.printed.join("")).toContain("more than 7 days out");
  for (const [name, env, lane, revoke, refusal] of [
    ["Other_Test", "OTHER_KEY", laneA, "https://example.com/keys", "lowercase letters, digits and hyphens"],
    ["other-test", "other-key", laneA, "https://example.com/keys", "--env takes a variable name"],
    ["other-test", "OTHER_KEY", "two words", "https://example.com/keys", "--lane takes the lane key"],
    ["other-test", "OTHER_KEY", laneA, "http://example.com/keys", "--revoke takes the https link"],
  ] as const) {
    expect(await lanePut(machine, name, laneValue(), "--lane", lane, "--env", env, "--why", "intake", "--revoke", revoke)).toBe(1);
    expect(machine.printed.join("")).toContain(refusal);
  }
  expect(await lanePut(machine, "send-us", laneValue(), "--lane", laneA, "--env", "EXAMPLE_API_KEY", "--why", "intake", "--revoke", "https://example.com/keys")).toBe(1);
  expect(machine.printed.join("")).toContain("send-us is a declared secret");
  expect(await lanePut(machine, "stripe-test", laneValue(), "--lane", laneB, "--env", "STRIPE_KEY", "--why", "intake", "--revoke", "https://example.com/keys")).toBe(1);
  expect(machine.printed.join("")).toContain(`stripe-test is held by lane ${laneA}`);
  expect(await lanePut(machine, "stripe-test", laneValue(), "--lane", laneA, "--env", "STRIPE_KEY", "--why", "missed", "--revoke", "https://example.com/keys")).toBe(0);
  const before = machine.printed.length;
  expect(await machine.dev("list")).toBe(0);
  expect(machine.since(before)).toContain(`stripe-test: lane, lane, scope lane ${laneA} (unchecked: its provider has no check), stored 2026-11-13, store expiry 2026-11-20; env STRIPE_KEY`);
  machine.expectNoLeak();
});

test("drop removes only its own lane's values, and a lane secret past 7 days is refused and swept with old unnamed value files", async () => {
  const machine = fleet();
  const kept = laneValue();
  expect(await lanePut(machine, "lane-a-key", laneValue(), "--lane", laneA, "--env", "A_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/a")).toBe(0);
  expect(await lanePut(machine, "lane-b-key", kept, "--lane", laneB, "--env", "B_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/b")).toBe(0);
  expect(valueFiles(machine.hubHome)).toHaveLength(2);
  expect(await machine.dev("drop", "--lane", laneA)).toBe(0);
  expect(machine.printed.at(-1)).toBe(`Dropped lane-a-key of lane ${laneA}; their values are deleted.\n`);
  expect(valueFiles(machine.hubHome).filter((file) => file.startsWith("lane-a-key."))).toEqual([]);
  expect((await run(machine.dev, machine.printed, ["lane-a-key"], "echo child-ran")).code).toBe(1);
  expect((await run(machine.dev, machine.printed, ["lane-b-key"], `[ "$B_KEY" = "${kept}" ] && echo kept`)).text).toContain("kept");
  expect(await machine.dev("drop", "--lane", laneA)).toBe(0);
  expect(machine.printed.at(-1)).toBe(`Lane ${laneA} holds no secret; nothing to drop.\n`);
  machine.clock.now = new Date("2026-11-20T11:00:00Z");
  const refused = await run(machine.dev, machine.printed, ["lane-b-key"], "echo child-ran");
  expect(refused.code).toBe(1);
  expect(refused.text).toContain("past its store expiry 2026-11-20");
  const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  writeFileSync(join(valuesDir(machine.hubHome), "orphan.p-000000000001"), "X=made-up-orphan\n", { mode: 0o600 });
  utimesSync(join(valuesDir(machine.hubHome), "orphan.p-000000000001"), hourAgo, hourAgo);
  writeFileSync(join(valuesDir(machine.hubHome), "fresh.p-000000000002"), "X=made-up-fresh\n", { mode: 0o600 });
  expect(await machine.dev("sweep")).toBe(0);
  expect(machine.printed.at(-1)).toBe("The hub hub keeps this machine's secrets and sweeps them each night; nothing to sweep here.\n");
  expect(await machine.hub("sweep")).toBe(0);
  expect(machine.printed.at(-1)).toBe("Swept 1 lane value past its store expiry and 1 value file that no current put names.\n");
  expect(valueFiles(machine.hubHome)).toEqual(["fresh.p-000000000002"]);
  expect(await lanePut(machine, "lane-b-key", laneValue(), "--lane", laneA, "--env", "B_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/c")).toBe(0);
  machine.expectNoLeak(["made-up-orphan", "made-up-fresh"]);
});

test("a sweep's late drop of an expired lane put leaves the lane's renewal delivered", async () => {
  const machine = fleet();
  expect(await lanePut(machine, "stripe-test", laneValue(), "--lane", laneA, "--env", "STRIPE_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/a")).toBe(0);
  const [expired] = putIds(machine.hubHome, "stripe-test");
  machine.clock.now = new Date("2026-11-21T10:00:00Z");
  const renewed = laneValue();
  expect(await lanePut(machine, "stripe-test", renewed, "--lane", laneA, "--env", "STRIPE_KEY", "--why", "expired", "--revoke", "https://example.com/revoke/a")).toBe(0);
  appendFileSync(eventLogPath(machine.hubHome), `${JSON.stringify({ type: "drop", name: "stripe-test", lane: laneA, put: expired, at: "2026-11-21T10:00:01Z" })}\n`);
  expect((await run(machine.dev, machine.printed, ["stripe-test"], `[ "$STRIPE_KEY" = "${renewed}" ] && echo renewed`)).text).toContain("renewed");
  machine.expectNoLeak();
});

test("two lanes that claim one name at once: the first append wins, and the other put is refused and leaves no value", async () => {
  const machine = fleet();
  const first = laneValue();
  machine.hooks.beforeAppend = () => machine.putElsewhere({ name: "stripe-test", lane: laneA, env: "STRIPE_KEY", value: first });
  expect(await lanePut(machine, "stripe-test", laneValue(), "--lane", laneB, "--env", "STRIPE_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/b")).toBe(1);
  expect(machine.printed.join("")).toContain(`stripe-test is held by lane ${laneA}`);
  expect((await run(machine.dev, machine.printed, ["stripe-test"], `[ "$STRIPE_KEY" = "${first}" ] && echo first`)).text).toContain("first");
  expect(valueFiles(machine.hubHome)).toHaveLength(1);
  machine.expectNoLeak();
});

test("a lane put whose revoke link, lane key or name would show the value, or whose printed lines would complete it, is refused without showing it", async () => {
  const machine = fleet();
  const quoted = `pw"${crypto.randomUUID()}`;
  values.push(quoted);
  expect(await lanePut(machine, "stripe-test", quoted, "--lane", laneA, "--env", "STRIPE_KEY", "--why", "intake", "--revoke", `https://example.com/revoke?k=${quoted}`)).toBe(1);
  const name = `bad-${crypto.randomUUID()}`;
  values.push(name);
  expect(await lanePut(machine, name, name, "--lane", laneA, "--env", "STRIPE_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/a")).toBe(1);
  expect(machine.printed.join("")).toContain("Refused, and the reason would show part of the value");
  const id = crypto.randomUUID();
  const lane = `t-${id}`;
  for (const { value, revoke } of [
    { value: `${id}.`, revoke: `https://example.com/revoke/${id}` },
    { value: `${lane}):`, revoke: "https://example.com/revoke/a" },
    { value: `${lane}; store`, revoke: "https://example.com/revoke/a" },
    { value: `${lane}; their`, revoke: "https://example.com/revoke/a" },
  ]) {
    values.push(value);
    expect(await lanePut(machine, "stripe-test", value, "--lane", lane, "--env", "STRIPE_KEY", "--why", "intake", "--revoke", revoke)).toBe(1);
  }
  expect(valueFiles(machine.hubHome)).toEqual([]);
  expect(await machine.dev("drop", "--lane", lane)).toBe(0);
  machine.expectNoLeak();
});

test("list --due names a lane secret within a day of its store expiry, and its need card is a lane put", async () => {
  const machine = fleet();
  expect(await lanePut(machine, "stripe-test", laneValue(), "--lane", laneA, "--env", "STRIPE_KEY", "--why", "intake", "--expires", "2026-11-16")).toBe(0);
  let before = machine.printed.length;
  expect(await machine.dev("list", "--due")).toBe(0);
  expect(machine.since(before)).not.toContain("stripe-test");
  const empty = fleet({ rows: [] });
  expect(await empty.dev("list", "--due")).toBe(0);
  expect(empty.printed).toEqual(["Nothing due: no standing secret expires within 7 days, and no lane secret within 1 day.\n"]);
  machine.clock.now = new Date("2026-11-15T12:00:00Z");
  before = machine.printed.length;
  expect(await machine.dev("list", "--due")).toBe(0);
  expect(machine.since(before)).toContain("stripe-test: expires 2026-11-16.");
  machine.clock.now = new Date("2026-11-16T12:00:00Z");
  before = machine.printed.length;
  expect(await machine.dev("list", "--need", "stripe-test")).toBe(0);
  const card = machine.since(before);
  expect(card).toContain("stripe-test: past its store expiry 2026-11-16.");
  expect(card).toContain(`fleet secret put stripe-test --file <the saved file> --lane ${laneA} --env STRIPE_KEY --why <why> (--expires <a date within 7 days> | --revoke <link>)`);
  machine.expectNoLeak();
});

test("the sweep deletes only the store's own value files: a pack's files and current values stay, a replaced value goes, and without an event log nothing unnamed goes", async () => {
  const machine = fleet();
  const dir = valuesDir(machine.hubHome);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const aged = (path: string, text: string) => { writeFileSync(path, text, { mode: 0o600 }); utimesSync(path, old, old); };
  mkdirSync(join(dir, "chat"), { recursive: true });
  aged(join(dir, "chat", "app.p-000000000003"), "made-up-pack-file\n");
  aged(join(dir, "notes"), "made-up-notes\n");
  aged(join(dir, "orphan.p-000000000004"), "X=made-up-orphan\n");
  expect(await machine.hub("sweep")).toBe(0);
  expect(machine.printed.at(-1)).toBe("Swept 0 lane values past their store expiry and 0 value files that no current put names.\n");
  expect(valueFiles(machine.hubHome)).toEqual(["chat", "notes", "orphan.p-000000000004"]);
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, `${sendKey}\n`))).toBe(0);
  const renewed = laneValue();
  expect(await lanePut(machine, "stripe-test", laneValue(), "--lane", laneA, "--env", "STRIPE_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/a")).toBe(0);
  expect(await lanePut(machine, "stripe-test", renewed, "--lane", laneA, "--env", "STRIPE_KEY", "--why", "revoked", "--revoke", "https://example.com/revoke/a")).toBe(0);
  const [replaced, current] = putIds(machine.hubHome, "stripe-test");
  expect(await machine.hub("sweep")).toBe(0);
  expect(machine.printed.at(-1)).toBe("Swept 0 lane values past their store expiry and 2 value files that no current put names.\n");
  expect(valueFiles(machine.hubHome)).toEqual(["chat", "notes", `send-us.${putIds(machine.hubHome, "send-us")[0]}`, `stripe-test.${current}`]);
  expect(valueFiles(machine.hubHome)).not.toContain(`stripe-test.${replaced}`);
  expect(readFileSync(join(dir, "chat", "app.p-000000000003"), "utf8")).toBe("made-up-pack-file\n");
  expect((await run(machine.dev, machine.printed, ["stripe-test", "send-us"], `[ "$STRIPE_KEY" = "${renewed}" ] && [ "$EXAMPLE_API_KEY" = "${sendKey}" ] && echo both`)).text).toContain("both");
  machine.expectNoLeak(["made-up-orphan", "made-up-pack-file", "made-up-notes"]);
});

test("the report gets each lane secret's latest revoke link and its late puts from the hub, never a value", async () => {
  const machine = fleet();
  expect(await lanePut(machine, "stripe-test", laneValue(), "--lane", laneA, "--env", "STRIPE_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/old")).toBe(0);
  machine.clock.now = new Date("2026-11-14T09:30:00Z");
  expect(await lanePut(machine, "stripe-test", laneValue(), "--lane", laneA, "--env", "STRIPE_KEY", "--why", "expired", "--revoke", "https://example.com/revoke/new")).toBe(0);
  expect(await lanePut(machine, "mail-test", laneValue(), "--lane", laneA, "--env", "MAIL_KEY", "--why", "missed", "--expires", "2026-11-16")).toBe(0);
  expect(await lanePut(machine, "other-test", laneValue(), "--lane", laneB, "--env", "OTHER_KEY", "--why", "missed", "--revoke", "https://example.com/revoke/b")).toBe(0);
  expect(await machine.dev("drop", "--lane", laneA)).toBe(0);
  const expected = {
    revokes: [`- Revoke stripe-test (lane ${laneA}): https://example.com/revoke/new`],
    late: ["- stripe-test put 2026-11-14 09:30 UTC, why expired.", "- **Miss:** mail-test put 2026-11-14 09:30 UTC, why missed."],
  };
  expect(await laneSecretLines({ home: machine.devHome, env: machine.devEnv, ssh: machine.ssh }, laneA)).toEqual(expected);
  expect(await laneSecretLines({ home: machine.hubHome, env: machine.hubEnv, ssh: machine.ssh }, laneA)).toEqual(expected);
  machine.reach.hub = false;
  await expect(laneSecretLines({ home: machine.devHome, env: machine.devEnv, ssh: machine.ssh }, laneA)).rejects.toThrow("did not send the lane's secret lines (exit 255)");
  machine.expectNoLeak();
});

test("the hub withholds a report line that would show a value it holds, even one another process stored without the put checks", async () => {
  const machine = fleet();
  const spelled = "Revoke beta-key";
  values.push(spelled);
  machine.putElsewhere({ name: "beta-key", lane: laneA, env: "BETA_KEY", value: laneValue(), revoke: "https://example.com/revoke/b" });
  machine.putElsewhere({ name: "other-key", lane: laneB, env: "OTHER_KEY", value: spelled });
  expect(await laneSecretLines({ home: machine.devHome, env: machine.devEnv, ssh: machine.ssh }, laneA)).toEqual({ revokes: ["A line was withheld, as it would show a stored value."], late: [] });
  machine.expectNoLeak();
});

test("a put whose name, lane or link would show a value the store holds, or whose value the log already shows, is refused", async () => {
  const machine = fleet();
  const held = laneValue();
  expect(await lanePut(machine, "held-key", held, "--lane", laneA, "--env", "HELD_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/a")).toBe(0);
  expect(await lanePut(machine, "other-test", laneValue(), "--lane", laneB, "--env", "OTHER_KEY", "--why", "intake", "--revoke", `https://example.com/revoke/${held}`)).toBe(1);
  expect(machine.printed.at(-1)).toBe("Fleet secret: The other-test put's name, lane or links would show a value the store holds. Nothing was stored\n");
  const shownBefore = "example.com/revoke/abcdef123";
  expect(await lanePut(machine, "link-test", laneValue(), "--lane", laneB, "--env", "LINK_KEY", "--why", "intake", "--revoke", `https://${shownBefore}`)).toBe(0);
  expect(await lanePut(machine, "later-test", shownBefore, "--lane", laneB, "--env", "LATER_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/c")).toBe(1);
  expect(machine.printed.at(-1)).toBe("Fleet secret: Refused, and the reason would show part of the value. Nothing was stored\n");
  expect(valueFiles(machine.hubHome)).toHaveLength(2);
  machine.expectNoLeak();
});

test("a drop or a sweep whose drop event does not land whole keeps the value and says so", async () => {
  const machine = fleet();
  const kept = laneValue();
  expect(await lanePut(machine, "stripe-test", kept, "--lane", laneA, "--env", "STRIPE_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/a")).toBe(0);
  const tornDrop = () => {
    let split = false;
    machine.hooks.write = (file, bytes, offset) => {
      if (!split && offset === 12 && Buffer.from(bytes).includes('"type":"drop"')) { split = true; machine.offElsewhere("torn drop")(); }
      return writeSync(file, bytes, offset, 1);
    };
  };
  tornDrop();
  expect(await machine.dev("drop", "--lane", laneA)).toBe(1);
  expect(machine.printed.at(-1)).toContain("The drop of stripe-test did not land whole in the event log, so its value stays");
  expect(valueFiles(machine.hubHome)).toHaveLength(1);
  machine.hooks.write = undefined;
  machine.clock.now = new Date("2026-11-21T10:00:00Z");
  tornDrop();
  expect(await machine.hub("sweep")).toBe(1);
  expect(machine.printed.at(-1)).toContain("did not land whole");
  expect(valueFiles(machine.hubHome)).toHaveLength(1);
  machine.expectNoLeak();
});

test("the sweep's own line is withheld when it would spell a stored value", async () => {
  const machine = fleet();
  const swept = "Swept 0 lane values";
  values.push(swept);
  expect(await lanePut(machine, "stripe-test", swept, "--lane", laneA, "--env", "STRIPE_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/a")).toBe(0);
  expect(await machine.hub("sweep")).toBe(0);
  expect(machine.printed.at(-1)).toBe("A line was withheld, as it would show a stored value.\n");
  machine.expectNoLeak();
});

test("a lane put, a drop or a report against a hub with an older fleet secret stores nothing and says nothing was done", async () => {
  const machine = fleet();
  machine.reach.older = true;
  expect(await lanePut(machine, "send-us", laneValue(), "--lane", laneA, "--env", "SEND_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/a")).toBe(1);
  expect(machine.printed.at(-1)).toBe("Fleet secret: the hub runs an older fleet secret that has no lane put, so nothing was done there. Run fleet update on the hub\n");
  expect(valueFiles(machine.hubHome)).toEqual([]);
  expect(await machine.dev("drop", "--lane", laneA)).toBe(1);
  expect(machine.printed.at(-1)).toBe("Fleet secret: the hub runs an older fleet secret that has no drop, so nothing was done there. Run fleet update on the hub\n");
  await expect(laneSecretLines({ home: machine.devHome, env: machine.devEnv, ssh: machine.ssh }, laneA)).rejects.toThrow("has no lane read");
  machine.expectNoLeak();
});

test("a value that spells a line Fleet prints later, such as a due line or a drop that names several secrets, never shows", async () => {
  const machine = fleet();
  const due = "stripe-test: expires";
  const joined = "alpha-key, beta-key";
  values.push(due, joined);
  for (const spelled of [due, '"type":"drop"', "### Late secret puts"]) {
    expect(await lanePut(machine, "stripe-test", spelled, "--lane", laneA, "--env", "STRIPE_KEY", "--why", "intake", "--expires", "2026-11-16")).toBe(1);
    expect(machine.printed.at(-1)).toBe("Fleet secret: Refused, and the reason would show part of the value. Nothing was stored\n");
  }
  expect(await lanePut(machine, "alpha-key", joined, "--lane", laneA, "--env", "ALPHA_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/a")).toBe(0);
  expect(await lanePut(machine, "beta-key", laneValue(), "--lane", laneA, "--env", "BETA_KEY", "--why", "intake", "--revoke", "https://example.com/revoke/b")).toBe(0);
  machine.clock.now = new Date("2026-11-19T12:00:00Z");
  expect(await machine.dev("list", "--due")).toBe(0);
  expect(await machine.dev("drop", "--lane", laneA)).toBe(0);
  expect(machine.printed.at(-1)).toBe("A line was withheld, as it would show a stored value.\n");
  expect(valueFiles(machine.hubHome)).toEqual([]);
  machine.expectNoLeak();
});
