import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { analyze, render } from "./analyze.ts";
import { budget } from "./budget.ts";
import { collect } from "./collect.ts";
import { join } from "node:path";
import { tempDirs } from "../../../../src/testing/git.ts";
import { boxSettings, fakeCoder, fakeMachine, writeHome, writePool } from "../testing.ts";
import { release, sweep } from "../box.ts";
import { digestClaude, digestCodex, digestLines, dreamHooks, inboxDir, localDigests, parseSince, repoOf, saveBoxDigests } from "./digest.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const now = Date.parse("2026-11-05T04:10:00Z");
const hourAgo = (minutes = 0) => new Date(now - 3_600_000 + minutes * 60_000).toISOString();

function claudeSession(home: string, cwd: string, lines: unknown[], name = "s-1") {
  writeHome(home, { [`.claude/projects/-dev-app/${name}.jsonl`]: lines.map((line) => JSON.stringify(line)).join("\n") });
  return join(home, `.claude/projects/-dev-app/${name}.jsonl`);
}

const user = (cwd: string, text: unknown, minutes: number, extra: object = {}) =>
  ({ type: "user", sessionId: "s-1", cwd, timestamp: hourAgo(minutes), message: { role: "user", content: text }, ...extra });
const assistant = (cwd: string, content: unknown[], minutes: number, id = `m-${minutes}`, usage?: object) =>
  ({ type: "assistant", sessionId: "s-1", cwd, timestamp: hourAgo(minutes), message: { id, role: "assistant", model: "claude-test", content, ...(usage ? { usage } : {}) } });

test("a Claude digest keeps the person's words, the agent's replies, failed tools, skills, memory reads and writes, and the effort before the first edit", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const path = claudeSession(home, cwd, [
    user(cwd, "<system-reminder>ignore me</system-reminder>Fix the login bug", 0),
    assistant(cwd, [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: join(home, ".agents/memory/tech/login.md") } }], 1, "m-1", { input_tokens: 100, output_tokens: 10 }),
    assistant(cwd, [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test" } }], 2, "m-1", { input_tokens: 100, output_tokens: 20 }),
    user(cwd, [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "1 test failed" }], 3),
    assistant(cwd, [{ type: "tool_use", id: "t3", name: "Skill", input: { skill: "tdd" } }, { type: "tool_use", id: "t4", name: "Edit", input: { file_path: join(cwd, "login.ts") } }], 4, "m-2", { input_tokens: 50 }),
    assistant(cwd, [{ type: "tool_use", id: "t5", name: "Write", input: { file_path: join(home, ".agents/memory/tech/login.md") } }], 5, "m-3"),
    { type: "user", isSidechain: true, sessionId: "s-1", cwd, timestamp: hourAgo(6), message: { role: "user", content: "a subagent's prompt" } },
    user(cwd, "<command-name>/clear</command-name>", 7),
    "not json {",
  ]);
  const digest = digestClaude(path, "devbox-1", home, {});
  expect(digest).toMatchObject({
    machine: "devbox-1", provider: "claude", session: "s-1", cwd, repo: "app", model: "claude-test", toolCalls: 5,
    skills: ["tdd"], memoryReads: ["tech/login.md"], memoryWrites: ["tech/login.md"], tokens: 170,
    effort: { tokens: 170, toolCalls: 4, errors: 1, seconds: 240 },
  });
  expect(digest.entries.map((entry) => `${entry.role}: ${entry.text}`)).toEqual([
    "user: Fix the login bug", "assistant: Looking.", "error: Bash {\"command\":\"bun test\"} → 1 test failed",
  ]);
});

test("a Claude digest clips a long message and says how much it left out", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const digest = digestClaude(claudeSession(home, cwd, [user(cwd, "x".repeat(2500), 0)]), "devbox-1", home, {});
  expect(digest.entries[0]!.text).toBe(`${"x".repeat(2000)} […500 more]`);
});

test("a Codex digest reads its session, model, tokens, messages, failed commands, and memory edits, and skips its injected instructions", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, ".t3/worktrees/shop/t3-1");
  const lines = [
    { type: "session_meta", payload: { id: "c-1", cwd } },
    { type: "turn_context", payload: { model: "gpt-test" } },
    { type: "response_item", timestamp: hourAgo(0), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } },
    { type: "response_item", timestamp: hourAgo(1), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a cart page" }] } },
    { type: "response_item", timestamp: hourAgo(2), payload: { type: "function_call", call_id: "f1", name: "shell", arguments: "{\"command\":\"bun test\"}" } },
    { type: "response_item", timestamp: hourAgo(3), payload: { type: "function_call_output", call_id: "f1", output: "Process exited with code 1" } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 900 } } } },
    { type: "response_item", timestamp: hourAgo(4), payload: { type: "custom_tool_call", call_id: "f2", name: "apply_patch", input: "*** Update File: cart.ts" } },
    { type: "response_item", timestamp: hourAgo(5), payload: { type: "custom_tool_call", call_id: "f3", name: "apply_patch", input: `*** Add File: ${home}/.agents/memory/projects/shop/cart.md` } },
    { type: "response_item", timestamp: hourAgo(6), payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
  ];
  writeHome(home, { ".codex/sessions/2026/11/05/rollout-c-1.jsonl": lines.map((line) => JSON.stringify(line)).join("\n") });
  const digest = digestCodex(join(home, ".codex/sessions/2026/11/05/rollout-c-1.jsonl"), "devbox-1", home, {});
  expect(digest).toMatchObject({
    provider: "codex", session: "c-1", repo: "shop", model: "gpt-test", tokens: 900, toolCalls: 3,
    memoryWrites: ["projects/shop/cart.md"], effort: { tokens: 900, toolCalls: 2, errors: 1, seconds: 240 },
  });
  expect(digest.entries.map((entry) => entry.role)).toEqual(["user", "error", "assistant"]);
});

test("repoOf names the repository from a worktree, a dev checkout, or the first folder, and the home otherwise", () => {
  expect(repoOf("/home/me/.t3/worktrees/shop/t3-1", "/home/me")).toBe("shop");
  expect(repoOf("/home/me/dev/app/src", "/home/me")).toBe("app");
  expect(repoOf("/home/me/notes", "/home/me")).toBe("notes");
  expect(repoOf("/home/me/.t3/scratch/abc", "/home/me")).toBe("scratch");
  expect(repoOf("/home/me", "/home/me")).toBe("home");
});

test("parseSince reads days, hours, and ISO times, and defaults to two days", () => {
  expect(parseSince(undefined, now)).toBe(now - 2 * 86_400_000);
  expect(parseSince("36h", now)).toBe(now - 36 * 3_600_000);
  expect(parseSince("2026-11-01T00:00:00Z", now)).toBe(Date.parse("2026-11-01T00:00:00Z"));
  expect(() => parseSince("soon", now)).toThrow("Cannot read --since soon");
});

test("local digests leave out sessions without the person's words, the dream's own sessions, and entries before the cutoff", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  claudeSession(home, cwd, [user(cwd, "old words", -2000), user(cwd, "new words", 0)], "s-1");
  claudeSession(home, cwd, [{ ...assistant(cwd, [{ type: "text", text: "no user" }], 0), sessionId: "s-2" }], "s-2");
  claudeSession(home, join(home, ".agents/memory"), [{ ...user(join(home, ".agents/memory"), "tidy", 0), sessionId: "s-3" }], "s-3");
  claudeSession(home, join(home, ".t3/scratch/a"), [{ ...user(join(home, ".t3/scratch/a"), "Follow the dream skill with the run directory /x.", 0), sessionId: "s-4" }], "s-4");
  const digests = localDigests(home, "devbox-1", now - 86_400_000, {});
  expect(digests.map((digest) => [digest.session, digest.entries.map((entry) => entry.text)])).toEqual([["s-1", ["new words"]]]);
});

test("a digest that the dream sends to analysts and the memory repo carries no token from the session", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const token = `ghp_${"a1".repeat(18)}`;
  claudeSession(home, cwd, [user(cwd, `Use this token: ${token}`, 0), assistant(cwd, [{ type: "text", text: `Saved ${token} for later.` }], 1)]);
  const output = digestLines(home, "devbox-1", now - 86_400_000, now, {});
  expect(output).toContain("[redacted GitHub token]");
  expect(output).not.toContain(token);
  expect(JSON.parse(output).repo).toBe("app");
});

test("digest output adds the saved box digests since the cutoff and deletes those older than 14 days", () => {
  const home = temp.make("fleet-dream-");
  const env = {};
  const inbox = inboxDir(home, env);
  writeHome(home, { [join(inbox.slice(home.length + 1), "box-a-1.jsonl")]: "{\"session\":\"fresh\"}\n", [join(inbox.slice(home.length + 1), "box-b-1.jsonl")]: "{\"session\":\"stale\"}\n", [join(inbox.slice(home.length + 1), "box-c-1.jsonl")]: "{\"session\":\"gone\"}\n" });
  utimesSync(join(inbox, "box-a-1.jsonl"), new Date(now - 3_600_000), new Date(now - 3_600_000));
  utimesSync(join(inbox, "box-b-1.jsonl"), new Date(now - 3 * 86_400_000), new Date(now - 3 * 86_400_000));
  utimesSync(join(inbox, "box-c-1.jsonl"), new Date(now - 15 * 86_400_000), new Date(now - 15 * 86_400_000));
  expect(digestLines(home, "my-hub", now - 86_400_000, now, env)).toBe("{\"session\":\"fresh\"}\n");
  expect(readdirSync(inbox).sort()).toEqual(["box-a-1.jsonl", "box-b-1.jsonl"]);
});

test("saving a box's digests keeps what the box printed, and a box that fails or prints nothing leaves nothing", async () => {
  const home = temp.make("fleet-dream-");
  const { coder, calls } = fakeCoder({ ssh: async (box, command) => (calls.push({ box, command }), { code: 0, stdout: box === "box-a" ? "{\"session\":\"s\"}\n" : "", stderr: "" }) });
  await saveBoxDigests(coder, "box-a", home, {}, () => now);
  await saveBoxDigests(coder, "box-b", home, {}, () => now);
  expect(calls.map((call) => call.command)).toEqual(Array(2).fill('sh "$HOME/.local/share/fleet/engine/fleet" dream digest --since 30d'));
  expect(readdirSync(inboxDir(home, {}))).toEqual([`box-a-${now}.jsonl`]);
  expect(readFileSync(join(inboxDir(home, {}), `box-a-${now}.jsonl`), "utf8")).toBe("{\"session\":\"s\"}\n");
  const broken = fakeCoder({ ssh: async () => { throw new Error("no route"); } });
  expect(saveBoxDigests(broken.coder, "box-c", home, {}, () => now)).resolves.toBeUndefined();
});

test("with Dream on, the sweep saves an idle box's digests before it stops the box; with Dream off it saves nothing", async () => {
  for (const dream of [true, false]) {
    const home = temp.make("fleet-dream-");
    const env = { FLEET_SETTINGS: JSON.stringify({ ...boxSettings, ...(dream ? { "hub.dreamSessions": 150 } : {}) }) };
    const order: string[] = [];
    const { machine } = fakeMachine(home);
    writePool(home, { boxes: { "box-lane": { id: "ws-box-lane" } } });
    const { coder, done } = fakeCoder({
      ssh: async (box, command) => {
        const digest = command.includes("dream digest");
        if (digest) await new Promise((resolve) => setImmediate(resolve));
        order.push(`${digest ? "digest" : "idle"} ${box}`);
        return { code: 0, stdout: digest ? "{\"session\":\"s\"}\n" : "", stderr: "" };
      },
    });
    const stop = coder.stop;
    coder.stop = async (id, timeoutMs) => {
      await stop(id, timeoutMs);
      order.push(done.at(-1)!);
    };
    expect(await sweep(coder, machine, dreamHooks(env, home, () => coder))).toBe(0);
    expect(order).toEqual(dream ? ["idle box-lane", "digest box-lane", "stop box-lane"] : ["idle box-lane", "stop box-lane"]);
    expect(existsSync(inboxDir(home, env))).toBe(dream);
  }
});

test("with Dream on, a release saves the box's digests before the box leaves", async () => {
  const home = temp.make("fleet-dream-");
  const env = { FLEET_SETTINGS: JSON.stringify({ ...boxSettings, "hub.dreamSessions": 150 }) };
  const { machine } = fakeMachine(home);
  const order: string[] = [];
  const { coder, done } = fakeCoder({
    ssh: async (box, command) => {
      if (!command.includes("dream digest")) return { code: 0, stdout: "", stderr: "" };
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`digest ${box}`);
      return { code: 0, stdout: "{\"session\":\"s\"}\n", stderr: "" };
    },
  });
  const remove = coder.remove;
  coder.remove = async (id, timeoutMs) => {
    await remove(id, timeoutMs);
    order.push(done.at(-1)!);
  };
  expect(await release(coder, machine, "box-lane", { hooks: dreamHooks(env, home, () => coder) })).toBe(0);
  expect(order).toEqual(["digest box-lane", "remove box-lane"]);
});

const credentialShapes = [
  ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", "eyJhbGciOiJIUzI1NiJ9"],
  [["curl", "-H", "'Authorization: Basic dXNlcjpwYXNzd29yZA=='"].join(" "), "dXNlcjpwYXNzd29yZA=="],
  ["curl -H \"X-Api-Key: k3y-v4lue-0042\" https://api.example.com", "k3y-v4lue-0042"],
  ["call it with Bearer ya29.a0AfH6SMBx-oauth-0042 today", "ya29.a0AfH6SMBx-oauth-0042"],
  ["{\"access_token\":\"oauth-access-0042\",\"refresh_token\": \"oauth-refresh-0042\"}", "oauth-"],
  ["API_KEY=plainkey0042", "plainkey0042"],
  ["export SECRET=\"quoted secret 0042\"", "quoted secret 0042"],
  ["PASSWORD='single-quoted-0042' DB_PASSWD=passwd0042", "0042"],
  ["GITHUB_TOKEN=tok0042 my_credential=cred0042 NEXTAUTH_SECRET=auth0042", "0042"],
  ["https://example.com/callback?code=1&access_token=query0042&page=2", "query0042"],
  ["DATABASE_URL is postgres://admin:hunter2pw@db.example.com:5432/app", "hunter2pw"],
  ["git clone https://x-access-token:clone0042@github.com/owner/repo.git", "clone0042"],
] as const;

test("a digest redacts headers, OAuth tokens, secret assignments, and URL passwords before it clips or serializes them", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const words = credentialShapes.map(([text]) => text).join("\n");
  const atClip = `${"x".repeat(2000 - "postgres://admin:hunter2pw".length)}postgres://admin:hunter2pw@db.example.com/app`;
  claudeSession(home, cwd, [
    user(cwd, words, 0),
    user(cwd, atClip, 1),
    assistant(cwd, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "curl -H \"Authorization: Bearer tool0042tool\" https://api.example.com" } }], 2),
    user(cwd, [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "exit code 1: SECRET_KEY=output0042 rejected" }], 3),
  ]);
  const output = digestLines(home, "devbox-1", now - 86_400_000, now, {});
  for (const [, secret] of credentialShapes) expect([secret, output.includes(secret)]).toEqual([secret, false]);
  for (const leaked of ["hunter2", "tool0042tool", "output0042"]) expect([leaked, output.includes(leaked)]).toEqual([leaked, false]);
  expect(output).toContain("Authorization: [redacted credential]");
  expect(output).toContain("API_KEY=[redacted credential]");
  expect(output).toContain("postgres://[redacted credential]@db.example.com:5432/app");
  expect(output).toContain("page=2");
});

test("redaction leaves ordinary text as it is", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const ordinary = [
    "The token count was 900, and the auth flow uses OAuth with Bearer tokens.",
    "const tokens = countTokens(text); if (key === secret) return;",
    "Open https://example.com/path?page=2&sort=asc or ssh://git@github.com/owner/repo.git, then mail me@example.com.",
    "Set NODE_ENV=production and PORT=8080. The Authorization: header was missing.",
  ].join("\n");
  claudeSession(home, cwd, [user(cwd, ordinary, 0)]);
  expect(JSON.parse(digestLines(home, "devbox-1", now - 86_400_000, now, {})).entries[0].text).toBe(ordinary);
});

test("a resumed dream session stays out even when its opening prompt is older than the cutoff", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, ".t3/scratch/a");
  claudeSession(home, cwd, [user(cwd, "Follow the dream skill with the run directory /x.", -2000), user(cwd, "Drop change 2", 0)]);
  expect(localDigests(home, "devbox-1", now - 86_400_000, {})).toEqual([]);
});

test("parseSince refuses a time with anything after it, such as a shell substitution", () => {
  expect(() => parseSince("2026-11-01 $(printf dream-injected)", now)).toThrow("Cannot read --since");
  expect(() => parseSince("2026-11-01T00:00:00Z; rm -rf ~", now)).toThrow("Cannot read --since");
  expect(() => parseSince("Nov 1 2026", now)).toThrow("Cannot read --since");
  expect(parseSince("2026-11-01", now)).toBe(Date.parse("2026-11-01T00:00:00Z"));
  expect(parseSince("2026-11-01T02:00:00+02:00", now)).toBe(Date.parse("2026-11-01T00:00:00Z"));
});

const fake = (...pieces: string[]) => pieces.join("");

test("a digest redacts the decoded tool input, the decoded tool result, and an error result before it clips them", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const keyBlock = `${fake("-----BEGIN", " RSA PRI", "VATE KEY-----")}\n${fake("MIIEow", "Fake42body", "x7Q2l9Zk")}\n${fake("-----END", " RSA PRI", "VATE KEY-----")}`;
  const sts = `CREDENTIALS\t${fake("ASIA", "ZZZZ", "FAKE", "9876", "5432")}\t2026-11-05T05:10:00Z\t${fake("wJalr", "FAKEsecret", "Fake44")}\t${fake("IQoJb3", "FAKEtoken", "Fake45")}`;
  claudeSession(home, cwd, [
    user(cwd, "Deploy it", 0),
    assistant(cwd, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: 'TOKEN="first-Fake42\nsecond-Fake43" ./deploy' } }], 1),
    user(cwd, [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: `exit code 1\n${sts}\n${JSON.stringify({ nested: JSON.stringify({ pem: keyBlock }) })}` }] }], 2),
  ]);
  const codexLines = [
    { type: "session_meta", payload: { id: "c-1", cwd } },
    { type: "response_item", timestamp: hourAgo(0), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Ship it" }] } },
    { type: "response_item", timestamp: hourAgo(1), payload: { type: "function_call", call_id: "f1", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", 'TOKEN="quoted-Fake46" ./ship'] }) } },
    { type: "response_item", timestamp: hourAgo(2), payload: { type: "function_call_output", call_id: "f1", output: JSON.stringify({ output: `Process exited with code 1\nexport API_KEY='out-Fake47'`, metadata: { exit_code: 1 } }) } },
  ];
  writeHome(home, { ".codex/sessions/2026/11/05/rollout-c-1.jsonl": codexLines.map((line) => JSON.stringify(line)).join("\n") });
  const output = digestLines(home, "devbox-1", now - 86_400_000, now, {});
  for (const secret of ["Fake42", "Fake43", "Fake44", "Fake45", "Fake46", "Fake47", "PRIVATE KEY", "ASIAZZZZ"]) expect([secret, output.includes(secret)]).toEqual([secret, false]);
  const [claude, codex] = output.trim().split("\n").map((line) => JSON.parse(line));
  expect(claude.entries.find((entry: { role: string }) => entry.role === "error").text).toContain("Bash {\"command\":\"TOKEN=[redacted credential] ./deploy\"} → exit code 1");
  expect(codex.entries.find((entry: { role: string }) => entry.role === "error").text).toContain("TOKEN=[redacted credential] ./ship");
});

test("a digest carries every third-round shape through redaction and leaves ordinary code alone", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const hunter = fake("hun", "ter");
  const jwt = fake("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJGYWtlNDIifQ", ".", "c2lnRmFrZTQy");
  const ordinary = "if (key===expected) {}\nconst key=event.key1;\nconst apiKey=deriveKey2();\nPORT=8080 git clone ssh://git@host/r.git";
  claudeSession(home, cwd, [
    user(cwd, `PASSWORD=${hunter}1 and SECRET="\${MISSING:-fallback-1234}"\nPASSWORD = ${hunter}2\napi_key = unquoted-123456\npassword: ${hunter}3\n${jwt}`, 0),
    user(cwd, ordinary, 1),
    assistant(cwd, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `curl -u admin:${hunter}4 --token tok0042tok https://api.example.com`, headers: { Authorization: "Bearer abc", Cookie: "a=b" } } }], 2),
    user(cwd, [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: `401\nmachine h login u password ${hunter}5\n${JSON.stringify({ password: hunter, "x-api-key": "k" })}` }], 3),
  ]);
  const output = digestLines(home, "devbox-1", now - 86_400_000, now, {});
  expect([hunter, "fallback-1234", "unquoted-123456", "tok0042tok", "c2lnRmFrZTQy", "Bearer abc", "a=b"].filter((secret) => output.includes(secret))).toEqual([]);
  const entries: Array<{ text: string }> = JSON.parse(output).entries;
  expect(entries.map((entry) => entry.text)).toContain(ordinary);
});

test("final finding 1: a digest redacts every cookie of a quoted header in a tool call and in a failed tool's output", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const cookies = [fake("theme", "=light"), fake("sessionid=", "fakeSession42"), fake("csrftoken=", "fakeCsrf43")].join("; ");
  claudeSession(home, cwd, [
    user(cwd, "Call the API", 0),
    assistant(cwd, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `curl -H "Cookie: ${cookies}" https://api.example.com` } }], 1),
    user(cwd, [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: `exit code 1\n< Set-Cookie: ${cookies}; Path=/\n> Cookie: ${cookies}` }], 2),
  ]);
  const output = digestLines(home, "devbox-1", now - 86_400_000, now, {});
  expect(["light", "fakeSession42", "fakeCsrf43"].filter((secret) => output.includes(secret))).toEqual([]);
  const error: string = JSON.parse(output).entries.find((entry: { role: string }) => entry.role === "error").text;
  expect(error).toBe('Bash {"command":"curl -H \\"Cookie: [redacted credential]\\" https://api.example.com"} → exit code 1\n< Set-Cookie: [redacted credential]\n> Cookie: [redacted credential]');
});

test("final finding 2: a digest redacts numbers and booleans under secret names, and keeps its own token counts", () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const pin = fake("8675", "309");
  const code = fake("9876", "54321");
  claudeSession(home, cwd, [
    user(cwd, "Log in", 0),
    assistant(cwd, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "login", password: Number(pin) } }], 1, "m-1", { input_tokens: 100, output_tokens: 20 }),
    user(cwd, [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: `exit code 1 ${JSON.stringify({ access_token: Number(code), auth: true, retries: 3 })}` }], 2),
    user(cwd, [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: JSON.stringify({ pin_token: Number(code) }) }], 3),
    assistant(cwd, [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: join(cwd, "login.ts") } }], 4, "m-2"),
  ]);
  const output = digestLines(home, "devbox-1", now - 86_400_000, now, {});
  expect([pin, code].filter((secret) => output.includes(secret))).toEqual([]);
  const digest = JSON.parse(output);
  expect(digest).toMatchObject({ tokens: 120, effort: { tokens: 120, toolCalls: 2, errors: 2 } });
  expect(digest.entries.filter((entry: { role: string }) => entry.role === "error").map((entry: { text: string }) => entry.text)).toEqual([
    'Bash {"command":"login","password":"[redacted credential]"} → exit code 1 {"access_token":"[redacted credential]","auth":"[redacted credential]","retries":3}',
    'Bash {"command":"login","password":"[redacted credential]"} → {"pin_token":"[redacted credential]"}',
  ]);
});

test("final finding 3: with FLEET_MEMORY_DIR set, both parsers record reads and writes in that checkout, so collect keeps the memory fresh", async () => {
  const home = temp.make("fleet-dream-");
  const memory = join(home, "notes/memory");
  const env = { FLEET_MEMORY_DIR: memory };
  const cwd = join(home, "dev/app");
  writeHome(home, {
    "notes/memory/MEMORY.md": "# Memory\n- [Rule](tech/rule.md)\n- [Tip](tech/tip.md)\n",
    "notes/memory/tech/rule.md": "---\nname: rule\ndescription: A rule\nmetadata:\n  type: reference\nmodified: 2026-01-01\n---\nA rule.\n",
    "notes/memory/tech/tip.md": "---\nname: tip\ndescription: A tip\nmetadata:\n  type: reference\nmodified: 2026-01-01\n---\nA tip.\n",
  });
  claudeSession(home, cwd, [
    user(cwd, "Fix it", 0),
    assistant(cwd, [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: join(memory, "tech/rule.md") } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: join(home, ".agents/memory/tech/elsewhere.md") } },
      { type: "tool_use", id: "t3", name: "Write", input: { file_path: join(memory, "tech/new.md") } },
    ], 1),
  ]);
  const codexLines = [
    { type: "session_meta", payload: { id: "c-1", cwd } },
    { type: "response_item", timestamp: hourAgo(2), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Ship it" }] } },
    { type: "response_item", timestamp: hourAgo(3), payload: { type: "function_call", call_id: "f1", name: "shell", arguments: JSON.stringify({ command: ["cat", `${memory}/tech/tip.md`] }) } },
    { type: "response_item", timestamp: hourAgo(4), payload: { type: "custom_tool_call", call_id: "f2", name: "apply_patch", input: `*** Update File: ${memory}/tech/rule.md` } },
  ];
  writeHome(home, { ".codex/sessions/2026/11/05/rollout-c-1.jsonl": codexLines.map((line) => JSON.stringify(line)).join("\n") });
  const [claude, codex] = digestLines(home, "devbox-1", now - 86_400_000, now, env).trim().split("\n").map((line) => JSON.parse(line));
  expect([claude.memoryReads, claude.memoryWrites]).toEqual([["tech/rule.md"], ["tech/new.md"]]);
  expect([codex.memoryReads, codex.memoryWrites]).toEqual([["tech/tip.md"], ["tech/rule.md"]]);
  const git = async () => ({ code: 0, stdout: "", stderr: "" });
  await collect("1d", { home, env, self: "devbox-1", now: () => now, peers: [], onPeer: git, boxes: () => undefined, git, say: () => {} });
  const usage = JSON.parse(readFileSync(join(home, ".local/state/fleet/dream/usage.json"), "utf8"));
  expect(Object.keys(usage).sort()).toEqual(["tech/new.md", "tech/rule.md", "tech/tip.md"]);
  expect(budget(memory, usage, now).filter((problem) => problem.problem.startsWith("stale"))).toEqual([]);
});

const filesUnder = (root: string): string[] => readdirSync(root).flatMap((name) => statSync(join(root, name)).isDirectory() ? filesUnder(join(root, name)) : [join(root, name)]);

async function collectAndAnalyze(home: string) {
  const git = async () => ({ code: 0, stdout: "", stderr: "" });
  const run = await collect("1d", { home, env: {}, self: "devbox-1", now: () => now, peers: [], onPeer: git, boxes: () => undefined, git, say: () => {} });
  const prompts: string[] = [];
  await analyze(run, { home, env: {}, limit: 10, jobs: 1, say: () => {}, analyst: async (item) => (prompts.push(render(item)), { taskType: "fix", findings: [] }) });
  const state = join(home, ".local/state/fleet/dream");
  return { prompts, stored: filesUnder(state).map((path) => readFileSync(path, "utf8")).join("\n") };
}

test("recheck finding 1: folded and multi-line quoted headers stay hidden from a tool call and a failed tool's output to the analyst", async () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const folded = fake("sessionid=", "fakeFolded", "99117");
  const response = fake("fake", "Digest", "77118");
  claudeSession(home, cwd, [
    user(cwd, "Call the API", 0),
    assistant(cwd, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `curl -H 'Cookie: theme=light;\n  ${folded}' https://api.example.com` } }], 1),
    user(cwd, [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: `exit code 1\n< Cookie: theme=light;\r\n\t${folded}\n< Authorization: Digest username="u",\n  response="${response}"\nnext` }], 2),
  ]);
  const codexLines = [
    { type: "session_meta", payload: { id: "c-1", cwd } },
    { type: "response_item", timestamp: hourAgo(3), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Ship it" }] } },
    { type: "response_item", timestamp: hourAgo(4), payload: { type: "function_call", call_id: "f1", name: "shell", arguments: "{}" } },
    { type: "response_item", timestamp: hourAgo(5), payload: { type: "function_call_output", call_id: "f1", output: `Process exited with code 1\nCookie: theme=light;\n\t${folded}` } },
  ];
  writeHome(home, { ".codex/sessions/2026/11/05/rollout-c-1.jsonl": codexLines.map((line) => JSON.stringify(line)).join("\n") });
  const output = digestLines(home, "devbox-1", now - 86_400_000, now, {});
  expect(["fakeFolded", response].filter((secret) => output.includes(secret))).toEqual([]);
  const error: string = JSON.parse(output.split("\n")[0]!).entries.find((entry: { role: string }) => entry.role === "error").text;
  expect(error).toBe(`Bash {"command":"curl -H 'Cookie: [redacted credential]' https://api.example.com"} → exit code 1\n< Cookie: [redacted credential]\n< Authorization: [redacted credential]\nnext`);
  const { prompts, stored } = await collectAndAnalyze(home);
  expect(prompts.length).toBe(2);
  expect(["fakeFolded", response].filter((secret) => prompts.join("\n").includes(secret) || stored.includes(secret))).toEqual([]);
});

test("recheck finding 2: a number array under a secret name in a failed tool's output stays hidden from the analyst", async () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const pin = fake("8675", "309");
  const other = fake("1234", "5678");
  claudeSession(home, cwd, [
    user(cwd, "Log in", 0),
    assistant(cwd, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "login", password: [{ value: Number(pin) }] } }], 1),
    user(cwd, [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: `exit code 1 {"access_token":[${pin},${other}],"retries":3}` }], 2),
  ]);
  const output = digestLines(home, "devbox-1", now - 86_400_000, now, {});
  expect([pin, other].filter((secret) => output.includes(secret))).toEqual([]);
  expect(JSON.parse(output).entries.find((entry: { role: string }) => entry.role === "error").text)
    .toBe('Bash {"command":"login","password":"[redacted credential]"} → exit code 1 {"access_token":"[redacted credential]","retries":3}');
  const { prompts, stored } = await collectAndAnalyze(home);
  expect([pin, other].filter((secret) => prompts.join("\n").includes(secret) || stored.includes(secret))).toEqual([]);
});

test("final recheck: a string inside a secret container ends only at its own quote, so a quote of the other kind cannot end the redaction early", async () => {
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  const pin = fake("8675", "309");
  claudeSession(home, cwd, [
    user(cwd, "Log in", 0),
    assistant(cwd, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "login" } }], 1),
    user(cwd, [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: `failed {'secret': ["]${pin}"], 'next': 1} and {"token": ['"]', '${pin}']}` }], 2),
  ]);
  const output = digestLines(home, "devbox-1", now - 86_400_000, now, {});
  expect(output.includes(pin)).toBe(false);
  expect(JSON.parse(output).entries.find((entry: { role: string }) => entry.role === "error").text)
    .toBe(`Bash {"command":"login"} → failed {'secret': '[redacted credential]', 'next': 1} and {"token": "[redacted credential]"}`);
  const { prompts, stored } = await collectAndAnalyze(home);
  expect(prompts.join("\n").includes(pin) || stored.includes(pin)).toBe(false);
});

test("recheck finding 3: token counts that are not a finite, non-negative number become 0 in tokens and effort, so nothing else rides along", async () => {
  const secret = fake("fake", "Token", "88227");
  const malformed: Array<[string, string]> = [["a string", JSON.stringify(`PASSWORD=${secret}`)], ["an object", JSON.stringify({ password: secret })], ["infinity", "1e999"], ["a negative count", "-5"]];
  for (const [label, value] of malformed) {
    const home = temp.make("fleet-dream-");
    const cwd = join(home, "dev/app");
    const codexLines = [
      JSON.stringify({ type: "session_meta", payload: { id: "c-1", cwd } }),
      JSON.stringify({ type: "response_item", timestamp: hourAgo(0), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Ship it" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: "VALUE" } } } }).replace('"VALUE"', value),
      JSON.stringify({ type: "response_item", timestamp: hourAgo(1), payload: { type: "custom_tool_call", call_id: "f1", name: "apply_patch", input: "*** Update File: cart.ts" } }),
    ];
    writeHome(home, { ".codex/sessions/2026/11/05/rollout-c-1.jsonl": codexLines.join("\n") });
    const output = digestLines(home, "devbox-1", now - 86_400_000, now, {});
    expect([label, output.includes(secret), JSON.parse(output).tokens, JSON.parse(output).effort.tokens]).toEqual([label, false, 0, 0]);
    const { stored } = await collectAndAnalyze(home);
    expect([label, stored.includes(secret)]).toEqual([label, false]);
  }
  const home = temp.make("fleet-dream-");
  const cwd = join(home, "dev/app");
  claudeSession(home, cwd, [
    user(cwd, "Fix it", 0),
    assistant(cwd, [{ type: "text", text: "Looking." }], 1, "m-1", { input_tokens: `PASSWORD=${secret}`, cache_read_input_tokens: { password: secret }, output_tokens: 20 }),
    assistant(cwd, [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: join(cwd, "a.ts") } }], 2, "m-2", { input_tokens: 5 }),
  ]);
  const digest = JSON.parse(digestLines(home, "devbox-1", now - 86_400_000, now, {}));
  expect([digest.tokens, digest.effort.tokens]).toEqual([25, 25]);
});
