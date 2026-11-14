import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, writeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadWord } from "../../pull-requests/lib/proof-answers.ts";
import type { Ssh, SshResult } from "./hub-transport.ts";
import { heldLimit, lineRedactor, secretCommand, type SecretContext } from "./secret-cli.ts";
import { providersSeam, rowsSeam } from "./secret-rows.ts";
import { appendToLog, eventLogPath, secretFilesDir, type CheckResult, type SecretRow, type WriteBytes } from "./secret-store.ts";

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
const text = (shown: string | Uint8Array) => typeof shown === "string" ? shown : Buffer.from(shown).toString("utf8");

function fleet({ words = [] as ThreadWord[], rows = testRows() as SecretRow[] | "injected", handlers = undefined as Record<string, string> | undefined } = {}) {
  const hubHome = newHome();
  const devHome = newHome();
  mkdirSync(join(hubHome, ".config/fleet"), { recursive: true });
  writeFileSync(join(hubHome, ".config/fleet/machine.json"), JSON.stringify({ role: "hub" }));
  const clock = { now: new Date("2026-11-13T10:00:00Z") };
  const printed: string[] = [];
  const commands: string[] = [];
  const reach: { hub: boolean; answer?: SshResult } = { hub: true };
  const hooks: { whileHearing?: () => Promise<unknown>; beforeAppend?: () => void; write?: WriteBytes } = {};
  const write: WriteBytes = (file, bytes, offset) => (hooks.write ?? ((at, all, from) => writeSync(at, all, from)))(file, bytes, offset);
  const threadWords = async () => { const step = hooks.whileHearing; hooks.whileHearing = undefined; await step?.(); return words; };
  const env = (machine: string) => ({ FLEET_SETTINGS: hubSettings, CODER_WORKSPACE_NAME: machine, T3CODE_THREAD_ID: "lane-thread", ...handlers ? { FLEET_HANDLERS: JSON.stringify(handlers) } : {} });
  const context = (home: string, machine: string): SecretContext => ({
    home, env: env(machine), now: () => clock.now, threadWords, out: (shown) => printed.push(text(shown)), err: (shown) => printed.push(text(shown)), ssh,
    write, appendLog: (path, line, writer) => { const step = hooks.beforeAppend; hooks.beforeAppend = undefined; step?.(); appendToLog(path, line, writer); }, ...rows === "injected" ? {} : { rows },
  });
  const ssh: Ssh = async (host, command, stdin) => {
    commands.push(command);
    if (host !== "hub" || !reach.hub) return { code: 255, stdout: "", stderr: "ssh: connect to host hub port 22: Connection timed out" };
    if (reach.answer) return reach.answer;
    const out: string[] = [];
    const err: string[] = [];
    const code = await secretCommand(["hub"], { ...context(hubHome, "hub"), stdin: async () => stdin ?? "", out: (shown) => out.push(text(shown)), err: (shown) => err.push(text(shown)) });
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
  const offElsewhere = (reason: string) => () => appendFileSync(eventLogPath(hubHome), `\n${JSON.stringify({ type: "off", id: `o-${reason.replaceAll(" ", "-")}`, reason, at: clock.now.toISOString(), machine: "other-process" })}\n`);
  return {
    hubHome, devHome, clock, printed, commands, reach, hooks, secretFile, offElsewhere,
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

test("run redacts each field of a two-field secret on its own, on stdout and stderr, and in an unterminated last line", async () => {
  const machine = fleet();
  expect(await machine.dev("put", "sandbox-login", "--file", machine.secretFile(machine.devHome, login()))).toBe(0);
  const script = [
    `echo "user $LOGIN_EMAIL"`,
    `printf 'pass %s\\n' "$LOGIN_PASSWORD"`,
    `echo "err $LOGIN_PASSWORD" >&2`,
    `printf 'last %s' "$LOGIN_EMAIL"`,
    "exit 3",
  ].join("; ");
  const result = await run(machine.dev, machine.printed, ["sandbox-login"], script);
  expect(result.code).toBe(3);
  for (const line of ["user", "pass", "err", "last"]) expect(result.text).toContain(`${line} [redacted sandbox-login]`);
  machine.expectNoLeak();
});

test("the output redactor joins a value split across chunks, inside a multibyte character and before a CRLF", () => {
  const value = `pw-${crypto.randomUUID().slice(0, 8)}-é€-${crypto.randomUUID().slice(0, 8)}`;
  const bytes = new TextEncoder().encode(`pass ${value}\r\nnext ${value}`);
  const inside = new TextEncoder().encode(`pass ${value.slice(0, value.indexOf("é"))}`).length + 1;
  const written: string[] = [];
  const redactor = lineRedactor([{ value, label: "[redacted sandbox-login]" }], (bytes) => written.push(text(bytes)));
  for (const [start, end] of [[0, 7], [7, inside], [inside, inside + 2], [inside + 2, bytes.length]] as const) redactor.push(bytes.slice(start, end));
  redactor.end();
  expect(written.join("")).toBe("pass [redacted sandbox-login]\r\nnext [redacted sandbox-login]");
});

test("the output redactor keeps every other byte of binary output, and streams a long line without a line break in bounded pieces", () => {
  const value = made("key_");
  const written: Uint8Array[] = [];
  const redactor = lineRedactor([{ value, label: "[redacted]" }], (bytes) => written.push(bytes));
  redactor.push(Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0xc3]), Buffer.from(` ${value} `), Buffer.from([0x80, 0x0a])]));
  expect(Buffer.concat(written)).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0xc3]), Buffer.from(" [redacted] "), Buffer.from([0x80, 0x0a])]));
  written.length = 0;
  const filler = "x".repeat(heldLimit);
  redactor.push(Buffer.from(`${filler}${value.slice(0, 10)}`));
  const early = written.length;
  redactor.push(Buffer.from(`${value.slice(10)}${filler}`));
  expect(early).toBeGreaterThan(0);
  redactor.end();
  const all = Buffer.concat(written).toString("utf8");
  expect(all).toBe(`${filler}[redacted]${filler}`);
  expect(Math.max(...written.map((piece) => piece.length))).toBeLessThanOrEqual(heldLimit + value.length + 10);  written.length = 0;
  redactor.push(Buffer.from(`${"y".repeat(heldLimit - 5)}${value}abc`));
  redactor.end();
  expect(Buffer.concat(written).toString("utf8")).toBe(`${"y".repeat(heldLimit - 5)}[redacted]abc`);
});

test("output pieces never join into a value, and a run of one repeated value still streams", () => {
  const written: Uint8Array[] = [];
  const joined = lineRedactor([{ value: "12345678", label: "[redacted row]" }, { value: "X[redacted row]", label: "[redacted row]" }], (bytes) => written.push(bytes));
  joined.push(Buffer.from(`${"z".repeat(heldLimit)}X12345678zzzzzz`));
  joined.end();
  expect(Buffer.concat(written).toString("utf8")).not.toContain("X[redacted row]");
  written.length = 0;
  const repeated = lineRedactor([{ value: "aaaaaaaa", label: "[redacted]" }], (bytes) => written.push(bytes));
  for (let piece = 0; piece < 4; piece++) repeated.push(Buffer.alloc(heldLimit, "a"));
  expect(Buffer.concat(written).toString("utf8")).toContain("[redacted]");
  repeated.end();
  expect(Buffer.concat(written).toString("utf8")).not.toContain("aaaaaaaa");
});

test("one large chunk without a line break streams in pieces of at most 64 KiB", () => {
  const written: Uint8Array[] = [];
  const redactor = lineRedactor([{ value: "12345678", label: "[redacted row]" }], (bytes) => written.push(bytes));
  redactor.push(Buffer.from(`${"z".repeat(heldLimit * 2 - 3)}12345678${"z".repeat(heldLimit * 2)}`));
  expect(written.length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...written.map((piece) => piece.length))).toBeLessThanOrEqual(heldLimit + "[redacted row]".length - "12345678".length);
  redactor.end();
  expect(Buffer.concat(written).toString("utf8")).toBe(`${"z".repeat(heldLimit * 2 - 3)}[redacted row]${"z".repeat(heldLimit * 2)}`);
});

test("a value longer than the streamed piece is held until it is complete, never written in part", () => {
  const big = made("big-").padEnd(heldLimit + 4_464, "q");
  const written: Uint8Array[] = [];
  const redactor = lineRedactor([{ value: big, label: "[redacted big]" }], (bytes) => written.push(bytes));
  redactor.push(Buffer.from(big.slice(0, heldLimit + 1)));
  expect(Buffer.concat(written).toString("utf8")).toBe("");
  redactor.push(Buffer.from(`${big.slice(heldLimit + 1)}\n`));
  redactor.end();
  expect(Buffer.concat(written).toString("utf8")).toBe("[redacted big]\n");
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
  expect(machine.printed.join("")).toContain("the hub hub did not answer (exit 255, so SSH to it likely failed)");
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
  expect(await machine.hub("put", "send-us", "--file", machine.secretFile(machine.hubHome, otherKey))).toBe(1);
  expect(machine.printed.join("")).toContain("The store failed (EACCES); its message is not shown, as it could hold a value. Nothing was stored");
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
  const machine = fleet({ words: [answer("m-before", "Yes, turn it on", "2026-11-13T09:00:00Z"), answer("m-typed", "Turn it on now", "2026-11-13T11:00:00Z", "typed"), answer("m-after", "Yes", "2026-11-13T11:00:00Z")] });
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
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes"', "--thread", "users-thread")).toBe(0);
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).text).toContain("child-ran");
  machine.clock.now = new Date("2026-11-13T10:30:00Z");
  expect(await machine.dev("off", "second leak")).toBe(0);
  const before = machine.printed.length;
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes"', "--thread", "users-thread")).toBe(1);
  expect(machine.since(before)).toContain("That message of the user's already turned the store on once");
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).code).toBe(1);
  machine.expectNoLeak();
});

test("an off that lands between the hub's read of the switch and its on event leaves the store off", async () => {
  const machine = fleet({ words: [answer("m-after", "Yes", "2026-11-13T11:00:00Z")] });
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  expect(await machine.dev("off", "first leak")).toBe(0);
  machine.clock.now = new Date("2026-11-13T12:00:00Z");
  machine.hooks.beforeAppend = machine.offElsewhere("racing leak");
  const before = machine.printed.length;
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes"', "--thread", "users-thread")).toBe(1);
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
  const machine = fleet({ words: [answer("m-after", "Yes", "2026-11-13T11:00:00Z")] });
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  expect(await machine.dev("off", "first leak")).toBe(0);
  machine.clock.now = new Date("2026-11-13T12:00:00Z");
  machine.hooks.whileHearing = () => machine.hub("off", "second leak");
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes"', "--thread", "users-thread")).toBe(1);
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

test("a value with a null character is refused on put, in an existing file, and from the hub, and no part of it is printed", async () => {
  const tail = made("after-null-");
  const withNull = `${made("key_")}\u0000${tail}`;
  const machine = fleet();
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, withNull))).toBe(1);
  expect(machine.printed.join("")).toContain("holds a null character");
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).text).toContain("send-us: missing");
  hubFile(machine.hubHome, ".config/fleet/chat-app.json", JSON.stringify({ ...chatTokens, botToken: withNull }));
  const existing = await run(machine.dev, machine.printed, ["chat-app"], "echo child-ran");
  expect(existing.code).toBe(1);
  expect(existing.text).toContain("holds a null character, so run could not pass it");
  machine.reach.answer = { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, delivered: [{ name: "send-us", values: { EXAMPLE_API_KEY: withNull } }] }) };
  const delivered = await run(machine.dev, machine.printed, ["send-us"], "echo child-ran");
  expect(delivered.code).toBe(1);
  expect(delivered.text).toContain("could not start sh");
  expect(delivered.text).not.toContain("child-ran");
  machine.expectNoLeak([tail, ...Object.values(chatTokens)]);
});

test("the fleet secret command prints a fixed message for an error that escapes it, never the error's text", async () => {
  const inSettings = made("key_");
  const entry = join(import.meta.dir, "../commands/secret.ts");
  const child = Bun.spawn([process.execPath, entry, "list"], { env: { ...process.env, HOME: newHome(), FLEET_SETTINGS: `{"hub": {"alias": "${inSettings}"`, FLEET_DEBUG: "1" }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).toBe("fleet secret: The store failed; its message is not shown, as it could hold a value\n");
  expect(stdout + stderr).not.toContain(inSettings);
});

test("a disk that writes one byte at a time still stores the whole value and a whole off, and one that writes nothing stores nothing", async () => {
  const slow = fleet();
  slow.hooks.write = (file, bytes, offset) => writeSync(file, bytes, offset, 1);
  expect(await slow.dev("put", "send-us", "--file", slow.secretFile(slow.devHome, sendKey))).toBe(0);
  expect((await run(slow.dev, slow.printed, ["send-us"], `[ "$EXAMPLE_API_KEY" = "${sendKey}" ] && echo whole-value`)).text).toContain("whole-value");
  expect(await slow.dev("off", "a slow disk")).toBe(0);
  const refused = await run(slow.dev, slow.printed, ["send-us"], "echo child-ran");
  expect(refused.text).toContain("(a slow disk)");
  expect(refused.text).not.toContain("child-ran");
  const stuck = fleet();
  stuck.hooks.write = () => 0;
  expect(await stuck.dev("put", "send-us", "--file", stuck.secretFile(stuck.devHome, sendKey))).toBe(1);
  expect(stuck.printed.join("")).toContain("The store failed; its message is not shown");
  stuck.hooks.write = undefined;
  expect((await run(stuck.dev, stuck.printed, ["send-us"], "echo child-ran")).text).toContain("send-us: missing");
  slow.expectNoLeak();
  stuck.expectNoLeak();
});

test("an off that lands between the pieces of a read or put event keeps the value from the reader, and the put reports nothing stored", async () => {
  const offMidway = (machine: ReturnType<typeof fleet>, kind: string) => {
    let split = false;
    machine.hooks.write = (file, bytes, offset) => {
      if (!split && offset === 12 && Buffer.from(bytes).includes(`"type":"${kind}"`)) { split = true; machine.offElsewhere(`leak seen mid ${kind}`)(); }
      return writeSync(file, bytes, offset, 1);
    };
  };
  const reader = fleet();
  expect(await reader.dev("put", "send-us", "--file", reader.secretFile(reader.devHome, sendKey))).toBe(0);
  offMidway(reader, "read");
  const result = await run(reader.dev, reader.printed, ["send-us"], "echo child-ran");
  expect(result.code).toBe(1);
  expect(result.text).toContain("did not land whole in the event log");
  expect(result.text).not.toContain("child-ran");
  const putter = fleet();
  offMidway(putter, "put");
  expect(await putter.dev("put", "send-us", "--file", putter.secretFile(putter.devHome, sendKey))).toBe(1);
  expect(putter.printed.join("")).toContain("did not land whole in the event log, so it was not stored");
  reader.expectNoLeak();
  putter.expectNoLeak();
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
  const context: SecretContext = { home, env: { FLEET_SETTINGS: "{}" }, rows: testRows(), out: (shown) => printed.push(text(shown)), err: (shown) => printed.push(text(shown)), now: () => new Date("2026-11-13T10:00:00Z") };
  const dir = secretFilesDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "card"), sendKey);
  expect(await secretCommand(["put", "send-us", "--file", join(dir, "card")], context)).toBe(0);
  expect(existsSync(join(eventLogPath(home)))).toBe(true);
  const machine = fleet();
  expect(await machine.dev("hub")).toBe(2);
  expect(machine.printed.join("")).toContain("fleet secret hub runs only on the hub");
});

const echoing = (name: string, check: (values: Record<string, string>) => Promise<CheckResult>) => testRows().map((row) => row.name !== name ? row : { ...row, provider: { name: row.provider.name, check } });

test("a provider that throws with a value, or a hub that fails with one on stderr, prints a fixed failure and no value", async () => {
  const throwing = async (values: Record<string, string>): Promise<CheckResult> => { throw new Error(`provider failed: ${Object.values(values).join(" ")}`); };
  let machine = fleet({ rows: echoing("send-us", throwing) });
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(1);
  expect(machine.printed.join("")).toContain("the check failed with an error it does not show");
  machine = fleet({ rows: echoing("chat-app", throwing) });
  hubFile(machine.hubHome, ".config/fleet/chat-app.json", JSON.stringify(chatTokens));
  expect(await machine.dev("list", "--need", "chat-app")).toBe(0);
  expect(machine.printed.join("")).toContain("chat-app: failing its check (the check failed with an error it does not show).");
  machine.expectNoLeak(Object.values(chatTokens));
  machine = fleet();
  for (const code of [1, 255]) {
    machine.reach.answer = { code, stdout: "", stderr: `Error: provider failed: ${sendKey}\n` };
    expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(1);
  }
  expect(machine.printed.join("")).toContain("the hub hub did not answer (exit 1). Its output is not shown");
  machine.expectNoLeak();
});

test("a refusal whose fixed fallback or printed prefix would spell the value falls back to a bare refusal", async () => {
  for (const spelled of ["Nothing was stored", "Fleet secret"]) {
    const machine = fleet({ rows: echoing("send-us", async ({ EXAMPLE_API_KEY: key = "" }) => ({ ok: false, reason: `the service rejected ${key}` })) });
    expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, spelled))).toBe(1);
    expect(machine.printed.join("")).not.toContain(spelled);
    expect(machine.printed.join("")).toContain("efused");
  }
});

test("a torn off line, or an off line without its fields, keeps the store off until the user's yes turns it on", async () => {
  for (const damaged of ['{"type":"off","id":"o-1","rea', '{"type":"off","id":"o-1"}']) {
    const machine = fleet({ words: [answer("m-after", "Yes, turn it on", "2026-11-13T11:00:00Z")] });
    expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
    appendFileSync(eventLogPath(machine.hubHome), `\n${damaged}`);
    let result = await run(machine.dev, machine.printed, ["send-us"], "echo child-ran");
    expect(result.code).toBe(1);
    expect(result.text).toContain("a damaged line in the event log, which may be a torn off");
    machine.clock.now = new Date("2026-11-13T12:00:00Z");
    expect(await machine.dev("on", "--words", '2026-11-13 "Yes, turn it on"', "--thread", "users-thread")).toBe(0);
    result = await run(machine.dev, machine.printed, ["send-us"], "echo child-ran");
    expect(result.text).toContain("child-ran");
  }
});

test("one message id turns the store on once per thread", async () => {
  const machine = fleet({ words: [answer("m-1", "Yes, turn it on", "2026-11-13T11:00:00Z"), { ...answer("m-1", "Yes", "2026-11-13T11:00:00Z"), thread: "other-thread" }] });
  for (const [thread, words] of [["users-thread", "Yes, turn it on"], ["other-thread", "Yes"]]) {
    machine.clock.now = new Date("2026-11-13T10:30:00Z");
    expect(await machine.dev("off", "suspected leak")).toBe(0);
    machine.clock.now = new Date("2026-11-13T12:00:00Z");
    expect(await machine.dev("on", "--words", `2026-11-13 "${words}"`, "--thread", thread!)).toBe(0);
  }
});

test("on refuses a no, a yes to another question, and a yes to a question that only holds the enable question", async () => {
  const machine = fleet({ words: [answer("m-no", "No, keep it off", "2026-11-13T11:00:00Z"), { ...answer("m-other", "Yes, ship it", "2026-11-13T11:00:00Z"), answered: "Merge the pull request?" }, { ...answer("m-negated", "Yes", "2026-11-13T11:00:00Z"), answered: "Do not turn the secret store back on?" }, answer("m-yes-off", "Yes, keep it off", "2026-11-13T11:00:00Z")] });
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  expect(await machine.dev("off", "suspected leak")).toBe(0);
  machine.clock.now = new Date("2026-11-13T12:00:00Z");
  expect(await machine.dev("on", "--words", '2026-11-13 "No, keep it off"', "--thread", "users-thread")).toBe(1);
  expect(machine.printed.join("")).toContain('not "Yes, turn it on", so the store stays off');
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes, keep it off"', "--thread", "users-thread")).toBe(1);
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes"', "--thread", "users-thread")).toBe(1);
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes, ship it"', "--thread", "users-thread")).toBe(1);
  expect(machine.printed.join("")).toContain('not "Turn the secret store back on?"');
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).code).toBe(1);
});

test("rows whose file fields set a variable they do not declare are refused before any value is read", async () => {
  const rows = testRows().filter((row) => row.file).map((row) => ({ ...row, file: { ...row.file!, fields: Object.fromEntries(Object.keys(row.file!.fields ?? { [row.env[0]!]: "" }).map((key) => [key, "SHARED_KEY"])) } }));
  const machine = fleet({ rows });
  hubFile(machine.hubHome, ".config/fleet/chat-app.json", JSON.stringify(chatTokens));
  const result = await run(machine.dev, machine.printed, ["chat-app", "speech"], "echo child-ran");
  expect(result.code).toBe(1);
  expect(result.text).toContain("which must be its variables CHAT_APP_TOKEN, CHAT_BOT_TOKEN, each once");
  expect(result.text).not.toContain("child-ran");
  machine.reach.answer = { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, delivered: [{ name: "one", values: { SHARED_KEY: sendKey } }, { name: "two", values: { SHARED_KEY: otherKey } }] }) };
  const forged = await run(machine.dev, machine.printed, ["one", "two"], "echo child-ran");
  expect(forged.code).toBe(1);
  expect(forged.text).toContain("two of one, two set SHARED_KEY, so none was used");
  machine.expectNoLeak(Object.values(chatTokens));
});

test("rows that repeat a variable, or map two file fields to one variable, are refused", async () => {
  const [send, , , chat] = testRows();
  for (const row of [{ ...send!, env: ["EXAMPLE_API_KEY", "EXAMPLE_API_KEY"] }, { ...chat!, file: { ...chat!.file!, fields: { appToken: "CHAT_APP_TOKEN", botToken: "CHAT_APP_TOKEN" } } }]) {
    const machine = fleet({ rows: [row] });
    expect(await machine.dev("list")).toBe(1);
    expect(machine.printed.join("")).toContain(`The secret row "${row.name}"`);
  }
});

test("--expires refuses an impossible calendar date and a time without its zone", async () => {
  const machine = fleet();
  for (const expires of ["2026-11-31", "2026-12-00", "2026-12-01T10:00", "2026-12-01T24:00Z"]) {
    expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey), "--expires", expires)).toBe(1);
  }
  expect(machine.printed.join("")).toContain("--expires takes a real date such as 2026-12-31");
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey), "--expires", "2026-12-01T10:00+01:00")).toBe(0);
  expect(machine.printed.join("")).toContain("store expiry 2026-12-01");
});

test("an off that lands during the last check withholds the answers", async () => {
  let machine: ReturnType<typeof fleet>;
  machine = fleet({ rows: echoing("chat-app", async () => { await machine.hub("off", "leak seen mid-check"); return { ok: true }; }) });
  hubFile(machine.hubHome, ".config/fleet/chat-app.json", JSON.stringify(chatTokens));
  expect(await machine.dev("list", "--need", "chat-app")).toBe(1);
  expect(machine.printed.join("")).toContain("(leak seen mid-check) during the checks, so their answers are withheld");
  expect(machine.printed.join("")).not.toContain("Nothing to ask");
});

test("put with two --file options deletes both request_secret files and stores nothing", async () => {
  const machine = fleet();
  const first = machine.secretFile(machine.devHome, sendKey);
  const second = machine.secretFile(machine.devHome, otherKey);
  expect(await machine.dev("put", "send-us", "--file", first, "--file", second)).toBe(2);
  expect([existsSync(first), existsSync(second)]).toEqual([false, false]);
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).code).toBe(1);
  machine.expectNoLeak();
});

test("a damaged line found after an earlier off needs a yes given after it was found", async () => {
  const machine = fleet({ words: [answer("m-old", "Yes", "2026-11-13T11:00:00Z"), answer("m-new", "Yes, turn it on", "2026-11-13T13:30:00Z")] });
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  machine.clock.now = new Date("2026-11-13T10:30:00Z");
  expect(await machine.dev("off", "earlier incident")).toBe(0);
  appendFileSync(eventLogPath(machine.hubHome), '\n{"type":"off","id":"o-torn","reason":"later incident","at":"2026-11-13T12:00');
  machine.clock.now = new Date("2026-11-13T13:00:00Z");
  const before = machine.printed.length;
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes"', "--thread", "users-thread")).toBe(1);
  expect(machine.since(before)).toContain("before the store went off on 2026-11-13T13:00Z");
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).code).toBe(1);
  machine.clock.now = new Date("2026-11-13T14:00:00Z");
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes, turn it on"', "--thread", "users-thread")).toBe(0);
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).text).toContain("child-ran");
});

test("an off that lands while the hub reads a value withholds the value, and logs the read as refused", async () => {
  const machine = fleet();
  expect(await machine.dev("put", "send-us", "--file", machine.secretFile(machine.devHome, sendKey))).toBe(0);
  machine.hooks.beforeAppend = machine.offElsewhere("leak seen mid-read");
  const result = await run(machine.dev, machine.printed, ["send-us"], "echo child-ran");
  expect(result.code).toBe(1);
  expect(result.text).toContain("leak seen mid-read");
  expect(result.text).not.toContain("child-ran");
  const events = readFileSync(eventLogPath(machine.hubHome), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  expect(events.map(({ type, refused }) => [type, refused ?? null])).toEqual([["put", null], ["off", null], ["read", null], ["read", "the store went off before this read"]]);
  machine.expectNoLeak();
});

test("off and on work while the rows fail to load, and a rows module that fails says why", async () => {
  const dir = newHome();
  const rows = join(dir, "rows.ts");
  const inError = made("token=");
  writeFileSync(rows, `export const rows = () => { throw new Error("cannot reach https://user:${inError}@example.com"); };\n`);
  const machine = fleet({ rows: "injected", handlers: { [rowsSeam]: rows }, words: [answer("m-yes", "Yes, turn it on", "2026-11-13T11:00:00Z")] });
  expect(await machine.dev("off", "suspected leak")).toBe(0);
  machine.clock.now = new Date("2026-11-13T12:00:00Z");
  expect(await machine.dev("on", "--words", '2026-11-13 "Yes, turn it on"', "--thread", "users-thread")).toBe(0);
  const before = machine.printed.length;
  expect(await machine.dev("list")).toBe(1);
  expect(machine.since(before)).toContain(`The secret rows or providers did not load; the error's own text is not shown, as it could hold a value. Load ${rows} with bun on the hub to see it`);
  machine.expectNoLeak([inError]);
});

test("an off that lands before list --need logs its read keeps the value from the provider's check", async () => {
  const heard: string[] = [];
  const service = Bun.serve({ port: 0, fetch: (request) => (heard.push(request.headers.get("Authorization") ?? ""), Response.json({ ok: true })) });
  const check = async (values: Record<string, string>) => {
    const response = await fetch(service.url, { headers: { Authorization: `Bearer ${values.CHAT_BOT_TOKEN}` } });
    return response.ok ? { ok: true as const } : { ok: false as const, reason: "the example service refused" };
  };
  try {
    const machine = fleet({ rows: echoing("chat-app", check) });
    hubFile(machine.hubHome, ".config/fleet/chat-app.json", JSON.stringify(chatTokens));
    expect(await machine.dev("list", "--need", "chat-app")).toBe(0);
    expect(heard).toEqual([`Bearer ${chatTokens.botToken}`]);
    heard.length = 0;
    machine.hooks.beforeAppend = machine.offElsewhere("leak seen before the check");
    expect(await machine.dev("list", "--need", "chat-app")).toBe(1);
    expect(machine.printed.join("")).toContain("No check ran with chat-app's value");
    expect(heard).toEqual([]);
    machine.expectNoLeak(Object.values(chatTokens));
  } finally {
    service.stop(true);
  }
});

test("a stored value whose row now sets other variables is refused until it is put again", async () => {
  const rows = testRows();
  const machine = fleet({ rows });
  expect(await machine.dev("put", "sandbox-login", "--file", machine.secretFile(machine.devHome, login()))).toBe(0);
  rows[2] = { ...rows[2]!, env: ["LOGIN_EMAIL", "LOGIN_PASSWORD", "LOGIN_CODE"] };
  const result = await run(machine.dev, machine.printed, ["sandbox-login"], "echo child-ran");
  expect(result.code).toBe(1);
  expect(result.text).toContain("stored for LOGIN_EMAIL LOGIN_PASSWORD, but its row now sets LOGIN_EMAIL LOGIN_PASSWORD LOGIN_CODE; put it again");
  machine.expectNoLeak();
});

test("a put through a provider without a check is stored with a note that it went unchecked", async () => {
  const machine = fleet();
  expect(await machine.dev("put", "sandbox-login", "--file", machine.secretFile(machine.devHome, login()))).toBe(0);
  const before = machine.printed.length;
  expect(await machine.dev("list")).toBe(0);
  expect(machine.since(before)).toContain("sandbox-login: standing, example-login, project Sandbox, scope the sandbox project only (unchecked: its provider has no check), stored");
});

test("an on request from a machine whose fleet secret predates the answer check asks for an update there", async () => {
  const machine = fleet();
  expect(await machine.dev("off", "suspected leak")).toBe(0);
  const printed: string[] = [];
  const code = await secretCommand(["hub"], { home: machine.hubHome, env: { FLEET_SETTINGS: "{}" }, rows: testRows(), out: (shown) => printed.push(text(shown)), err: (shown) => printed.push(text(shown)), stdin: async () => JSON.stringify({ op: "on", words: '2026-11-13 "Yes, turn it on"', thread: "users-thread" }) });
  expect(code).toBe(0);
  expect(JSON.parse(printed.join(""))).toEqual({ ok: false, error: "The calling machine's fleet secret sends no answer to check. Run fleet update there, then fleet secret on again" });
  expect((await run(machine.dev, machine.printed, ["send-us"], "echo child-ran")).code).toBe(1);
});
