import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadWord } from "../../pull-requests/lib/proof-answers.ts";
import type { Ssh } from "./hub-transport.ts";
import { secretCommand, type SecretContext } from "./secret-cli.ts";
import { providersSeam, rowsSeam } from "./secret-rows.ts";
import { eventLogPath, secretFilesDir, type CheckResult, type SecretRow } from "./secret-store.ts";

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));

const made = (prefix: string) => `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
const sendKey = made("key_");
const otherKey = made("key_");
const euKey = made("key_");
const foreignKey = made("key_");
const loginEmail = `sandbox-${crypto.randomUUID().slice(0, 8)}@example.com`;
const loginPassword = `pw-${crypto.randomUUID()}`;
const values = [sendKey, otherKey, euKey, foreignKey, loginEmail, loginPassword];

const projectKey = (project: string): SecretRow["provider"] => ({
  name: "example-project-key",
  check: async ({ EXAMPLE_API_KEY: key = "" }): Promise<CheckResult> => {
    if (key.startsWith("personal_")) return { ok: false, reason: "this is a personal key, not a project key" };
    if (key === foreignKey) return { ok: false, reason: `the key belongs to another project than ${project}` };
    return { ok: true, unchecked: "the example service proves only that the key may read" };
  },
});

const testRows = (): SecretRow[] => [
  { name: "send-us", provider: projectKey("12"), scope: "email:write", project: "12", region: "us", settings: "https://example.com/settings", env: ["EXAMPLE_API_KEY"] },
  { name: "send-eu", provider: projectKey("34"), scope: "email:write", project: "34", region: "eu", settings: "https://example.com/settings", env: ["EXAMPLE_API_KEY"] },
  { name: "sandbox-login", provider: { name: "example-login" }, scope: "the sandbox project only", project: "Sandbox", settings: "https://example.com/users", env: ["LOGIN_EMAIL", "LOGIN_PASSWORD"] },
  { name: "chat-app", provider: { name: "chat-app" }, scope: "the chat app's tokens", settings: "https://example.com/apps", env: ["CHAT_APP_TOKEN", "CHAT_BOT_TOKEN"], file: { path: ".config/fleet/chat-app.json", format: "json", fields: { appToken: "CHAT_APP_TOKEN", botToken: "CHAT_BOT_TOKEN" }, renew: "the steps in the chat pack's setup" } },
  { name: "speech", provider: { name: "speech" }, scope: "text to speech", settings: "https://example.com/keys", env: ["SPEECH_API_KEY"], file: { path: ".config/fleet/speech.env", format: "env", renew: "a 0600 ~/.config/fleet/speech.env with SPEECH_API_KEY=…" } },
  { name: "pager", provider: { name: "pager" }, scope: "one alert source", settings: "https://example.com/alerts", env: ["PAGER_URL", "PAGER_TOKEN"], file: { path: ".config/fleet/pager.env", format: "env", renew: "fleet page setup" } },
];

const newHome = () => { const home = mkdtempSync(join(tmpdir(), "fleet-secret-")); homes.push(home); return home; };

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

const hubSettings = JSON.stringify({ "hub.alias": "hub" });

function fleet({ words = [] as ThreadWord[], rows = testRows() as SecretRow[] | "injected", handlers = undefined as Record<string, string> | undefined } = {}) {
  const hubHome = newHome();
  const devHome = newHome();
  mkdirSync(join(hubHome, ".config/fleet"), { recursive: true });
  writeFileSync(join(hubHome, ".config/fleet/machine.json"), JSON.stringify({ role: "hub" }));
  const clock = { now: new Date("2026-11-13T10:00:00Z") };
  const printed: string[] = [];
  const commands: string[] = [];
  const reach = { hub: true };
  const hooks: { whileHearing?: () => Promise<unknown>; beforeAppend?: () => Promise<unknown> } = {};
  const threadWords = async () => { const step = hooks.whileHearing; hooks.whileHearing = undefined; await step?.(); return words; };
  const env = (machine: string) => ({ FLEET_SETTINGS: hubSettings, CODER_WORKSPACE_NAME: machine, T3CODE_THREAD_ID: "lane-thread", ...handlers ? { FLEET_HANDLERS: JSON.stringify(handlers) } : {} });
  const context = (home: string, machine: string): SecretContext => ({
    home, env: env(machine), now: () => clock.now, threadWords, out: (text) => printed.push(text), err: (text) => printed.push(text), ssh,
    beforeAppend: async () => { const step = hooks.beforeAppend; hooks.beforeAppend = undefined; await step?.(); }, ...rows === "injected" ? {} : { rows },
  });
  const ssh: Ssh = async (host, command, stdin) => {
    commands.push(command);
    if (host !== "hub" || !reach.hub) return { code: 255, stdout: "", stderr: "ssh: connect to host hub port 22: Connection timed out" };
    const out: string[] = [];
    const err: string[] = [];
    const code = await secretCommand(["hub"], { ...context(hubHome, "hub"), stdin: async () => stdin ?? "", out: (text) => out.push(text), err: (text) => err.push(text) });
    return { code, stdout: out.join(""), stderr: err.join("") };
  };
  const secretFile = (home: string, text: string) => {
    const dir = secretFilesDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, crypto.randomUUID());
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };
  const on = (home: string, machine: string) => (...args: string[]) => secretCommand(args, context(home, machine));
  return {
    hubHome, devHome, clock, printed, commands, reach, hooks, secretFile,
    hub: on(hubHome, "hub"), dev: on(devHome, "devbox-1"),
    since(before: number) { return printed.slice(before).join(""); },
    expectNoLeak(extra: string[] = []) {
      const shown = [...printed, ...commands, existsSync(eventLogPath(hubHome)) ? readFileSync(eventLogPath(hubHome), "utf8") : "", ...filesUnder(devHome).map((path) => readFileSync(path, "utf8"))].join("\n");
      for (const value of [...values, ...extra]) expect(shown).not.toContain(value);
    },
  };
}

async function run(machine: (...args: string[]) => Promise<number>, printed: string[], names: string[], script: string) {
  const before = printed.length;
  const code = await machine("run", ...names, "--", "sh", "-c", script);
  return { code, text: printed.slice(before).join("") };
}

const login = (email = loginEmail, password = loginPassword) => `LOGIN_EMAIL=${email}\nLOGIN_PASSWORD=${password}\n`;

test("a devbox puts a key through the hub over SSH stdin and runs a command with it, and no value lands in output, events, argv or the devbox", async () => {
  const machine = fleet();
  const file = machine.secretFile(machine.devHome, `${sendKey}\n`);
  expect(await machine.dev("put", "send-us", "--file", file)).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(machine.commands[0]).toContain("fleet\" secret hub");

  const result = await run(machine.dev, machine.printed, ["send-us"], `[ "$EXAMPLE_API_KEY" = "${sendKey}" ] && echo delivered`);
  expect(result.code).toBe(0);
  expect(result.text).toContain("delivered");
  expect(process.env.EXAMPLE_API_KEY).toBeUndefined();
  machine.expectNoLeak();
});

test("run redacts each field of a two-field secret on its own, on stdout and stderr, across split writes and in an unterminated last line", async () => {
  const machine = fleet();
  expect(await machine.dev("put", "sandbox-login", "--file", machine.secretFile(machine.devHome, login()))).toBe(0);
  const half = Math.floor(loginPassword.length / 2);
  const script = [
    `echo "user $LOGIN_EMAIL"`,
    `printf 'pass %s' "$(printf %s "$LOGIN_PASSWORD" | cut -c1-${half})"; sleep 0.02; printf '%s\\n' "$(printf %s "$LOGIN_PASSWORD" | cut -c${half + 1}-)"`,
    `echo "err $LOGIN_PASSWORD" >&2`,
    `printf 'last %s' "$LOGIN_EMAIL"`,
    "exit 3",
  ].join("; ");
  const result = await run(machine.dev, machine.printed, ["sandbox-login"], script);
  expect(result.code).toBe(3);
  for (const line of ["user", "pass", "err", "last"]) expect(result.text).toContain(`${line} [redacted sandbox-login]`);
  machine.expectNoLeak();
});

test("a value with a line break is refused, and the request_secret file is gone after a refused put", async () => {
  const machine = fleet();
  const file = machine.secretFile(machine.devHome, `${sendKey}\n${otherKey}\n`);
  expect(await machine.dev("put", "send-us", "--file", file)).toBe(1);
  expect(existsSync(file)).toBe(false);
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).code).toBe(1);
  machine.expectNoLeak();
});

test("put deletes the request_secret file when the hub cannot be reached or its other arguments are wrong, and prints nothing of it", async () => {
  const machine = fleet();
  machine.reach.hub = false;
  const file = machine.secretFile(machine.devHome, `${sendKey}\n`);
  expect(await machine.dev("put", "send-us", "--file", file)).toBe(1);
  expect(existsSync(file)).toBe(false);
  expect(machine.printed.join("")).toContain("did not answer over SSH");
  machine.reach.hub = true;
  const wrong = machine.secretFile(machine.devHome, sendKey);
  expect(await machine.dev("put", "send-us", "--file", wrong, "--why", "because")).toBe(2);
  expect(existsSync(wrong)).toBe(false);
  machine.expectNoLeak();
});

test("put takes only a file in T3's secret-file directory, and leaves any other file alone", async () => {
  const machine = fleet();
  const elsewhere = join(machine.devHome, "notes.txt");
  writeFileSync(elsewhere, `${sendKey}\n`);
  expect(await machine.dev("put", "send-us", "--file", elsewhere)).toBe(2);
  expect(readFileSync(elsewhere, "utf8")).toBe(`${sendKey}\n`);
  rmSync(elsewhere);
  machine.expectNoLeak();
});

test("a failed check keeps the old value delivered, and a personal key is refused for a project-key row", async () => {
  const machine = fleet();
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  const file = machine.secretFile(machine.devHome, foreignKey);
  expect(await machine.dev("put", "send-us", "--file", file)).toBe(1);
  expect(existsSync(file)).toBe(false);
  expect(machine.printed.join("")).toContain("the key belongs to another project than 12. The stored value stays");
  const personal = made("personal_");
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, personal))).toBe(1);
  expect(machine.printed.join("")).toContain("this is a personal key");
  expect((await run(machine.dev, machine.printed, ["send-us"], `[ "$EXAMPLE_API_KEY" = "${sendKey}" ] && echo old-value`)).text).toContain("old-value");
  machine.expectNoLeak([personal]);
});

test("a crash between the value file's rename and the event's append leaves the old value delivered", async () => {
  const machine = fleet();
  expect(await machine.hub("put", "send-us", "--file", machine.secretFile(machine.hubHome, sendKey))).toBe(0);
  chmodSync(eventLogPath(machine.hubHome), 0o400);
  await expect(machine.hub("put", "send-us", "--file", machine.secretFile(machine.hubHome, otherKey))).rejects.toThrow();
  chmodSync(eventLogPath(machine.hubHome), 0o600);
  expect((await run(machine.dev, machine.printed, ["send-us"], `[ "$EXAMPLE_API_KEY" = "${sendKey}" ] && echo old-value`)).text).toContain("old-value");
});

test("puts of two different names both survive, and two secrets that set one variable are refused together", async () => {
  const machine = fleet();
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  expect(await machine.dev("put", "sandbox-login", "--file", machine.secretFile(machine.devHome, login()))).toBe(0);
  expect((await run(machine.dev, machine.printed, ["send-us", "sandbox-login"], `[ "$EXAMPLE_API_KEY" = "${sendKey}" ] && [ "$LOGIN_PASSWORD" = "${loginPassword}" ] && echo both`)).text).toContain("both");
  expect(await machine.dev("put", "send-eu", "--file", machine.secretFile(machine.devHome, euKey))).toBe(0);
  const result = await run(machine.dev, machine.printed, ["send-us", "send-eu"], "echo child-ran");
  expect(result.code).toBe(1);
  expect(result.text).toContain("send-eu: sets EXAMPLE_API_KEY, as send-us does");
  expect(result.text).not.toContain("child-ran");
  machine.expectNoLeak();
});

const answer = (id: string, text: string, at: string, source: ThreadWord["source"] = "question"): ThreadWord => ({ thread: "users-thread", id, text, answered: "Turn the secret store back on?", at, source });

test("after off, run refuses on and off the hub, and only the user's answer given after it turns the store on", async () => {
  const machine = fleet({ words: [answer("m-before", "Yes, turn it on", "2026-11-13T09:00:00Z"), answer("m-typed", "Turn it on now", "2026-11-13T11:00:00Z", "typed"), answer("m-after", "Yes, turn it back on", "2026-11-13T11:00:00Z")] });
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  expect(await machine.dev("off", "suspected leak in a transcript")).toBe(0);
  machine.clock.now = new Date("2026-11-13T12:00:00Z");
  for (const where of [machine.dev, machine.hub]) {
    const result = await run(where, machine.printed, ["send-us"], "echo child-ran");
    expect(result.code).toBe(1);
    expect(result.text).toContain("The store is off");
    expect(result.text).not.toContain("child-ran");
  }
  const reads = readFileSync(eventLogPath(machine.hubHome), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === "read");
  expect(reads.map(({ machine: where, refused }) => [where, refused])).toEqual([["devbox-1", "the store is off"], ["hub", "the store is off"]]);
  expect(await machine.dev("on", "--thread", "users-thread")).toBe(2);
  expect(await machine.dev("on", "--words", '2026-11-13 "turn it on, I rotated"', "--thread", "users-thread")).toBe(1);
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes, turn it on"', "--thread", "users-thread")).toBe(1);
  expect(await machine.dev("on", "--words", '2026-11-13 "Turn it on now"', "--thread", "users-thread")).toBe(1);
  expect(machine.printed.join("")).toContain("is a message the user typed");
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).code).toBe(1);
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes, turn it back on"', "--thread", "users-thread")).toBe(0);
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).text).toContain("child-ran");
  machine.clock.now = new Date("2026-11-13T10:30:00Z");
  expect(await machine.dev("off", "second leak")).toBe(0);
  const before = machine.printed.length;
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes, turn it back on"', "--thread", "users-thread")).toBe(1);
  expect(machine.since(before)).toContain("That message of the user's already turned the store on once");
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).code).toBe(1);
  machine.expectNoLeak();
});

test("an off that lands between the hub's read of the switch and its on event leaves the store off", async () => {
  const machine = fleet({ words: [answer("m-after", "Yes, turn it back on", "2026-11-13T11:00:00Z")] });
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  expect(await machine.dev("off", "first leak")).toBe(0);
  machine.clock.now = new Date("2026-11-13T12:00:00Z");
  machine.hooks.beforeAppend = () => machine.hub("off", "racing leak");
  const before = machine.printed.length;
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes, turn it back on"', "--thread", "users-thread")).toBe(1);
  expect(machine.since(before)).toContain("(racing leak) while the user's words were read, so it stays off");
  const result = await run(machine.dev, machine.printed, ["send-us"], "echo child-ran");
  expect(result.code).toBe(1);
  expect(result.text).toContain("racing leak");
});

test("off --help prints the usage, an off reason that starts with a flag is refused, and the store stays on", async () => {
  const machine = fleet();
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  for (const where of [machine.dev, machine.hub]) {
    for (const help of ["--help", "-h"]) {
      const before = machine.printed.length;
      expect(await where("off", help)).toBe(0);
      expect(machine.since(before)).toContain("fleet secret off <reason>");
    }
    expect(await where("off", "--reason", "suspected leak")).toBe(2);
    expect(await where("off", " -x leak")).toBe(2);
  }
  expect(readFileSync(eventLogPath(machine.hubHome), "utf8")).not.toContain('"off"');
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).text).toContain("child-ran");
});

test("an off appended after a torn last line of the log still stops every read", async () => {
  const machine = fleet();
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  appendFileSync(eventLogPath(machine.hubHome), '{"type":"read","name":"send-us","at":"2026-11-');
  expect(await machine.dev("off", "suspected leak")).toBe(0);
  const result = await run(machine.dev, machine.printed, ["send-us"], "echo child-ran");
  expect(result.code).toBe(1);
  expect(result.text).toContain("The store is off");
});

test("an on whose off was followed by a newer off while the user's words were read leaves the store off", async () => {
  const machine = fleet({ words: [answer("m-after", "Yes, turn it back on", "2026-11-13T11:00:00Z")] });
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  expect(await machine.dev("off", "first leak")).toBe(0);
  machine.clock.now = new Date("2026-11-13T12:00:00Z");
  machine.hooks.whileHearing = () => machine.hub("off", "second leak");
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes, turn it back on"', "--thread", "users-thread")).toBe(1);
  const result = await run(machine.dev, machine.printed, ["send-us"], "echo child-ran");
  expect(result.code).toBe(1);
  expect(result.text).toContain("second leak");
});

test("a standing secret is refused past its 90-day store expiry, and a put past or beyond 90 days is refused", async () => {
  const machine = fleet();
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey), "--expires", "2026-11-12")).toBe(1);
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey), "--expires", "2027-03-01")).toBe(1);
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  machine.clock.now = new Date("2027-02-10T10:00:00Z");
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).code).toBe(0);
  machine.clock.now = new Date("2027-02-12T10:00:00Z");
  const result = await run(machine.dev, machine.printed, ["send-us"], "echo child-ran");
  expect(result.code).toBe(1);
  expect(result.text).toContain("past its store expiry 2027-02-11");
});

test("list shows each secret's kind, check note and state, and never a value", async () => {
  const machine = fleet();
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  const before = machine.printed.length;
  expect(await machine.dev("list")).toBe(0);
  const text = machine.since(before);
  expect(text).toContain("Store: on\n");
  expect(text).toContain("send-us: standing, example-project-key, project 12, US, scope email:write (unchecked: the example service proves only that the key may read), stored 2026-11-13, store expiry 2027-02-11; env EXAMPLE_API_KEY");
  expect(text).toContain("sandbox-login: standing, example-login, project Sandbox, scope the sandbox project only, missing; env LOGIN_EMAIL LOGIN_PASSWORD");
  machine.expectNoLeak();
});

async function loginOutput(email: string, password: string, script: string) {
  const machine = fleet();
  expect(await machine.dev("put", "sandbox-login", "--file", machine.secretFile(machine.devHome, login(email, password)))).toBe(0);
  return run(machine.dev, machine.printed, ["sandbox-login"], script);
}

test("two values that overlap in the output are redacted whole, with no fragment left", async () => {
  const shared = crypto.randomUUID().slice(0, 12);
  const result = await loginOutput(`alpha-${shared}`, `${shared}-omega`, `printf '%s\\n' "alpha-${shared}-omega"`);
  expect(result.text).toBe("[redacted sandbox-login]\n");
});

test("a value that its own label would spell is redacted with a plain label, and a line whose redaction still shows a value is withheld", async () => {
  expect((await loginOutput(loginEmail, "[redacted sandbox", `printf 'pw %s\\n' "$LOGIN_PASSWORD"`)).text).toBe("pw [redacted]\n");
  const inPlainLabel = await loginOutput(loginEmail, "redacted", `printf 'pw %s\\n' "$LOGIN_PASSWORD"; echo after`);
  expect(inPlainLabel.code).toBe(0);
  expect(inPlainLabel.text).not.toContain("redacted");
  expect(inPlainLabel.text).toContain("after\n");
  const spelled = "[redacted sandbox-login]!";
  const rebuilt = await loginOutput(spelled, loginPassword, `printf '%s!\\n' "$LOGIN_PASSWORD"`);
  expect(rebuilt.text).not.toContain(spelled);
  expect(rebuilt.text).not.toContain(loginPassword);
});

test("a value shorter than 8 characters is refused at put, and a value that starts with a byte order mark is still redacted", async () => {
  const machine = fleet();
  const file = machine.secretFile(machine.devHome, login(loginEmail, "dact"));
  expect(await machine.dev("put", "sandbox-login", "--file", file)).toBe(1);
  expect(existsSync(file)).toBe(false);
  expect(machine.printed.join("")).not.toContain("dact");
  expect((await run(machine.dev, machine.printed, ["sandbox-login"], "echo child-ran")).code).toBe(1);
  expect((await loginOutput(loginEmail, `﻿${loginPassword}`, `printf '%s\\n' "$LOGIN_PASSWORD"`)).text).toBe("[redacted sandbox-login]\n");
});

test("a put whose own record or list line would show the value is refused: a note's text or a field name", async () => {
  for (const password of ["the example service", "unchecked", "storeExpiresAt"]) {
    const rows = testRows().map((row) => row.name !== "sandbox-login" ? row : { ...row, provider: { name: "example-login", check: async () => ({ ok: true as const, unchecked: "the example service asked for a second factor" }) } });
    const machine = fleet({ rows });
    expect(await machine.dev("put", "sandbox-login", "--file", machine.secretFile(machine.devHome, login(loginEmail, password)))).toBe(1);
    expect(machine.printed.join("")).toContain("Refused, and the reason would show part of the value. Nothing was stored");
    expect(await machine.dev("list")).toBe(0);
    expect(machine.printed.join("")).not.toContain(password);
    expect(existsSync(eventLogPath(machine.hubHome)) ? readFileSync(eventLogPath(machine.hubHome), "utf8") : "").not.toContain(password);
  }
});

const chatTokens = { appToken: made("app-"), botToken: made("bot-") };

function hubFile(home: string, path: string, text: string, mode = 0o600) {
  mkdirSync(join(home, path, ".."), { recursive: true });
  writeFileSync(join(home, path), text, { mode });
  chmodSync(join(home, path), mode);
}

test("a secret the hub already holds in its own file is delivered under its variables, redacted, and stopped by off", async () => {
  const machine = fleet();
  hubFile(machine.hubHome, ".config/fleet/chat-app.json", JSON.stringify(chatTokens));
  const shown = await run(machine.dev, machine.printed, ["chat-app"], `[ "$CHAT_BOT_TOKEN" = "${chatTokens.botToken}" ] && echo "bot $CHAT_BOT_TOKEN app $CHAT_APP_TOKEN"`);
  expect(shown.code).toBe(0);
  expect(shown.text).toBe("bot [redacted chat-app] app [redacted chat-app]\n");
  expect(await machine.dev("off", "suspected leak")).toBe(0);
  expect((await run(machine.dev, machine.printed, ["chat-app"], "echo child-ran")).code).toBe(1);
  machine.expectNoLeak(Object.values(chatTokens));
});

test("an existing secret file that others can read is refused, and a put over an existing secret's name is refused", async () => {
  const machine = fleet();
  hubFile(machine.hubHome, ".config/fleet/chat-app.json", JSON.stringify(chatTokens), 0o644);
  const result = await run(machine.dev, machine.printed, ["chat-app"], "echo child-ran");
  expect(result.code).toBe(1);
  expect(result.text).toContain("readable only by its owner");
  expect(await machine.dev("put", "chat-app", "--file", machine.secretFile(machine.devHome, `CHAT_APP_TOKEN=${sendKey}\nCHAT_BOT_TOKEN=${otherKey}\n`))).toBe(1);
  expect(machine.printed.join("")).toContain("No declared secret chat-app is kept by the store");
  machine.expectNoLeak(Object.values(chatTokens));
});

test("list --need prints the card for each missing or failing secret, nothing for one that is held and passes, and logs each check's read", async () => {
  const rows = testRows().map((row) => row.name !== "chat-app" ? row : { ...row, provider: { name: "chat-app", check: async () => ({ ok: false as const, reason: "the chat service answered invalid_auth" }) } });
  const machine = fleet({ rows });
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  hubFile(machine.hubHome, ".config/fleet/chat-app.json", JSON.stringify(chatTokens));
  const before = machine.printed.length;
  expect(await machine.dev("list", "--need", "send-us", "sandbox-login", "chat-app")).toBe(0);
  const text = machine.since(before);
  expect(text).not.toContain("send-us");
  expect(text).toContain("sandbox-login: missing. Ask the user with one request_secret card");
  expect(text).toContain("one line per variable: LOGIN_EMAIL=…, LOGIN_PASSWORD=…");
  expect(text).toContain("fleet secret put sandbox-login --file <the saved file>");
  expect(text).toContain("chat-app: failing its check (the chat service answered invalid_auth).");
  expect(text).toContain("Then store it with: the steps in the chat pack's setup");
  const reads = readFileSync(eventLogPath(machine.hubHome), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === "read");
  expect(reads).toEqual([
    expect.objectContaining({ name: "send-us", check: true, machine: "devbox-1", thread: "lane-thread" }),
    expect.objectContaining({ name: "sandbox-login", check: true, refused: "missing" }),
    expect.objectContaining({ name: "chat-app", check: true }),
  ]);
  expect(await machine.dev("list", "--need", "no-such-secret")).toBe(1);
  expect(await machine.dev("list", "--need")).toBe(2);
  const all = machine.printed.length;
  expect(await machine.dev("list", "--need", "send-us")).toBe(0);
  expect(machine.since(all)).toBe("Nothing to ask: send-us is held and passes its check.\n");
  machine.expectNoLeak(Object.values(chatTokens));
});

test("list --need guards a check's reason that would show a value, and stops at an off that lands during a check", async () => {
  let machine: ReturnType<typeof fleet>;
  const rows = testRows().map((row) => row.name !== "chat-app" ? row : { ...row, provider: { name: "chat-app", check: async (fields: Record<string, string>) => ({ ok: false as const, reason: `token ${fields.CHAT_BOT_TOKEN} revoked` }) } });
  const offing = testRows().map((row) => row.name !== "chat-app" ? row : { ...row, provider: { name: "chat-app", check: async () => { await machine.hub("off", "leak seen mid-check"); return { ok: true as const }; } } });
  machine = fleet({ rows });
  hubFile(machine.hubHome, ".config/fleet/chat-app.json", JSON.stringify(chatTokens));
  expect(await machine.dev("list", "--need", "chat-app")).toBe(0);
  expect(machine.printed.join("")).toContain("chat-app: failing its check (its reason would show part of the value).");
  machine.expectNoLeak(Object.values(chatTokens));

  machine = fleet({ rows: offing });
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  hubFile(machine.hubHome, ".config/fleet/chat-app.json", JSON.stringify(chatTokens));
  expect(await machine.dev("list", "--need", "chat-app", "send-us")).toBe(1);
  expect(machine.printed.join("")).toContain("leak seen mid-check");
  const reads = readFileSync(eventLogPath(machine.hubHome), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === "read");
  expect(reads.at(-1)).toEqual(expect.objectContaining({ name: "send-us", check: true, refused: "the store is off" }));
});

test("list and list --due read an existing secret's file metadata only, so they work while the store is off and on a broken file", async () => {
  const machine = fleet();
  hubFile(machine.hubHome, ".config/fleet/chat-app.json", "null", 0o200);
  hubFile(machine.hubHome, ".config/fleet/speech.env", `SPEECH_API_KEY=${crypto.randomUUID()}\n`, 0o644);
  expect(await machine.dev("off", "suspected leak")).toBe(0);
  let before = machine.printed.length;
  expect(await machine.dev("list")).toBe(0);
  let text = machine.since(before);
  expect(text).toContain("Store: off since 2026-11-13T10:00Z (suspected leak)");
  expect(text).toContain("chat-app: existing, chat-app, scope the chat app's tokens, own file ~/.config/fleet/chat-app.json;");
  expect(text).toContain("speech: existing, speech, scope text to speech, own file ~/.config/fleet/speech.env, readable by others (chmod 600);");
  expect(text).toContain("pager: existing, pager, scope one alert source, own file ~/.config/fleet/pager.env, missing;");
  before = machine.printed.length;
  expect(await machine.dev("list", "--due")).toBe(0);
  text = machine.since(before);
  expect(text).toContain("pager: missing.");
  expect(text).not.toContain("chat-app:");
});

test("an existing file's reasons never show a value it holds, down to a bare mark, and a value shorter than 8 characters is refused", async () => {
  for (const [other, reason] of [[chatTokens.botToken, "~/.config/fleet/chat-app.json is unusable, and the reason would show part of a value it holds"], ["is unusable", "unusable"], ["unusable", "✗"]] as const) {
    const machine = fleet();
    hubFile(machine.hubHome, ".config/fleet/chat-app.json", JSON.stringify({ appToken: "botToken", other }));
    expect(await machine.dev("list", "--need", "chat-app")).toBe(0);
    expect((await run(machine.dev, machine.printed, ["chat-app"], "echo child-ran")).code).toBe(1);
    const printed = machine.printed.join("");
    expect(printed).toContain(`chat-app: ${reason}.`);
    const log = readFileSync(eventLogPath(machine.hubHome), "utf8");
    for (const shown of [printed, log]) expect(shown).not.toContain(chatTokens.botToken);
    expect(log.split("\n").filter(Boolean).map((line) => JSON.parse(line).refused)).toEqual([reason, reason]);
  }
  const machine = fleet();
  hubFile(machine.hubHome, ".config/fleet/speech.env", "SPEECH_API_KEY=k3y9\n");
  expect(await machine.dev("list", "--need", "speech")).toBe(0);
  expect(machine.printed.join("")).toContain("speech: SPEECH_API_KEY in ~/.config/fleet/speech.env is shorter than 8 characters, so run could not redact it.");
});

test("list --due names a standing secret within 7 days of its expiry, one past it, and one missing", async () => {
  const machine = fleet();
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey), "--expires", "2026-11-18")).toBe(0);
  machine.clock.now = new Date("2026-11-14T10:00:00Z");
  expect(await machine.dev("put", "send-eu", "--file", machine.secretFile(machine.devHome, euKey))).toBe(0);
  const due = async () => { const before = machine.printed.length; expect(await machine.dev("list", "--due")).toBe(0); return machine.since(before); };
  let text = await due();
  expect(text).toContain("send-us: expires 2026-11-18.");
  expect(text).toContain("sandbox-login: missing.");
  expect(text).not.toContain("send-eu");
  machine.clock.now = new Date("2026-11-19T10:00:00Z");
  text = await due();
  expect(text).toContain("send-us: expired 2026-11-18.");
  machine.expectNoLeak();
});

test("rows and providers come from the packs' handlers, and a row whose provider no pack brings refuses every put", async () => {
  const dir = newHome();
  const providers = join(dir, "providers.ts");
  const rows = join(dir, "rows.ts");
  writeFileSync(providers, `export const providers = { "prefix-key": ({ prefix }) => ({ name: "prefix-key", check: async ({ EXAMPLE_API_KEY }) => EXAMPLE_API_KEY.startsWith(prefix) ? { ok: true } : { ok: false, reason: "the key has the wrong prefix" } }) };\n`);
  writeFileSync(rows, `export const rows = (provider) => [
  { name: "send-us", provider: provider("prefix-key", { prefix: "key_" }), scope: "email:write", settings: "https://example.com", env: ["EXAMPLE_API_KEY"] },
  { name: "orphan-key", provider: provider("absent-provider"), scope: "nothing", settings: "https://example.com", env: ["ORPHAN_KEY"] },
];\n`);
  const machine = fleet({ rows: "injected", handlers: { [rowsSeam]: rows, [providersSeam]: providers } });
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, made("wrong_")))).toBe(1);
  expect(machine.printed.join("")).toContain("the key has the wrong prefix");
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  expect(await machine.dev("put", "orphan-key", "--file", machine.secretFile(machine.devHome, otherKey))).toBe(1);
  expect(machine.printed.join("")).toContain("no pack on this hub brings the absent-provider provider");
  const before = machine.printed.length;
  expect(await machine.dev("list")).toBe(0);
  expect(machine.since(before)).toContain("orphan-key: standing, absent-provider, scope nothing, missing; env ORPHAN_KEY");
  machine.expectNoLeak();
});

test("without a hub alias the store lives on this machine, and only the hub serves fleet secret hub", async () => {
  const home = newHome();
  const printed: string[] = [];
  const context: SecretContext = { home, env: { FLEET_SETTINGS: "{}" }, rows: testRows(), out: (text) => printed.push(text), err: (text) => printed.push(text), now: () => new Date("2026-11-13T10:00:00Z") };
  const dir = secretFilesDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "card"), sendKey);
  expect(await secretCommand(["put", "send-us", "--file", join(dir, "card")], context)).toBe(0);
  expect(existsSync(join(eventLogPath(home)))).toBe(true);
  const machine = fleet();
  expect(await machine.dev("hub")).toBe(2);
  expect(machine.printed.join("")).toContain("fleet secret hub runs only on the hub");
});
