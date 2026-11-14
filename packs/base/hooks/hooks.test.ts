import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { check, reminder } from "./name-a-model.ts";
import { dispatch, type HookResult } from "./run.ts";
import { guard, type HookEvent } from "./secret-guard.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const body = (length: number) => "a1B2c3D4e5".repeat(Math.ceil(length / 10)).slice(0, length);
const fakesBuiltAtRuntime: Array<[kind: string, value: string]> = [
  ["PostHog personal API key", `ph${"x"}_${body(43)}`],
  ["PostHog secret API key", `ph${"s"}_${body(43)}`],
  ["PostHog OAuth token", `ph${"a"}_${body(43)}`],
  ["GitHub token", `gh${"p"}_${body(36)}`],
  ["GitHub token", `github${"_pat_"}${body(82)}`],
  ["OpenAI or Anthropic API key", `s${"k-"}proj-${body(48)}`],
  ["OpenAI or Anthropic API key", `s${"k-"}ant-api03-${body(90)}`],
  ["Slack token", `xo${"xb"}-123456789012-1234567890123-${body(24)}`],
  ["Slack token", `xa${"pp"}-1-A0123456789-1234567890123-${body(64)}`],
  ["Slack webhook URL", `https://hooks.slack.com/services/T${body(10).toUpperCase()}/B${body(10).toUpperCase()}/${body(24)}`],
  ["Convex deploy key", `prod${":"}happy-otter-123|${body(60)}`],
  ["private key", `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----\n${body(70)}\n`],
  ["private key", JSON.stringify({ private_key: `-----BEGIN ${"PRIVATE"} KEY-----\n${body(64)}\n${body(20)}\n-----END PRIVATE KEY-----\n` })],
  ["private key", `-----BEGIN RSA ${"PRIVATE"} KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,${body(32)}\n\n${body(64)}\n-----END RSA PRIVATE KEY-----\n`],
  ["Metabase session cookie", `metabase${"."}SESSION=${body(8)}-${body(4)}-${body(4)}-${body(4)}-${body(12)}`],
];

const promptEvent = (text: string): HookEvent => ({ hook_event_name: "UserPromptSubmit", prompt: text });
const toolEvent = (tool_response: unknown): HookEvent => ({ hook_event_name: "PostToolUse", tool_response });
const [, githubToken] = fakesBuiltAtRuntime[3];
const [, convexKey] = fakesBuiltAtRuntime.find(([kind]) => kind === "Convex deploy key")!;
const coderToken = `${body(10)}-${body(22)}`;

describe("secret guard", () => {
  test.each(fakesBuiltAtRuntime)("blocks a prompt that carries a %s and points at request_secret", (kind, secret) => {
    for (const provider of ["claude", "codex"] as const) {
      const decision = guard(provider, promptEvent(`Here is the key you asked for: ${secret} thanks`))!;
      expect(decision.decision).toBe("block");
      expect(decision.reason).toContain(kind);
      expect(decision.reason).toContain("request_secret");
      expect(JSON.stringify(decision)).not.toContain(secret);
    }
  });

  test.each([
    ["Markdown emphasis", `_${githubToken}_`],
    ["terminal colour", `\x1b[32m${githubToken}\x1b[0m`],
    ["a Convex label", `CONVEX_DEPLOY_KEY:${convexKey}`],
  ])("finds a secret wrapped in %s", (_, text) => {
    expect(guard("codex", promptEvent(text))?.decision).toBe("block");
  });

  test.each([
    "Block prompts that carry phs_, phx_, ghp_, github_pat_, sk- or xoxb- keys.",
    "Install sk-learn and the scikit-learn-intelex-extension-for-faster-training package.",
    "Rebase sk-simplify-2-factor-authentication-flow onto main.",
  ])("lets a prompt through that only talks about secrets: %s", (text) => {
    expect(guard("claude", promptEvent(text))).toBeUndefined();
  });

  test.each([
    ["the bare output of coder tokens create", `${coderToken}\n`],
    ["a JSON-escaped output line", `{"stdout":"${coderToken}\\n"}`],
    ["a coloured output line", `\x1b[32m${coderToken}\x1b[0m\n`],
    ["a session header", `curl -H 'Coder-Session-Token: ${coderToken}' https://coder.example.com/api/v2/users/me`],
    ["an environment line", `export CODER_SESSION_TOKEN="${coderToken}"\nHOME=/home/coder`],
    ["a JSON field", JSON.stringify({ coder_session_token: coderToken, user: "me" })],
    ["a JSON-escaped coloured line", JSON.stringify({ stdout: `\x1b[32m${coderToken}\x1b[0m\n` })],
    ["a single-quoted string", `token='${coderToken}'`],
    ["coder login's token flag", `coder login https://coder.example.com --token ${coderToken}`],
    ["coder login's token flag with =", `coder login https://coder.example.com --token="${coderToken}"`],
    ["a header with wide whitespace", `curl -H 'Coder-Session-Token:${" ".repeat(12)}${coderToken}' https://coder.example.com`],
  ])("redacts a Coder session token in %s", (_, stdout) => {
    const claude = guard("claude", toolEvent({ stdout }))!;
    expect(JSON.stringify(claude)).toContain("[redacted Coder session token]");
    expect(JSON.stringify(claude)).not.toContain(coderToken);
    expect(guard("codex", toolEvent({ stdout }))?.decision).toBe("block");
  });

  test("redacts a Coder session token held as a structured field", () => {
    const decision = guard("claude", toolEvent({ structuredContent: { coderSessionToken: coderToken, region: "us" } }))!;
    expect(decision.hookSpecificOutput).toMatchObject({ updatedToolOutput: { structuredContent: { coderSessionToken: "[redacted Coder session token]", region: "us" } } });
  });

  test.each([
    `Rebase ${coderToken} onto main.`,
    "Merge monitoring-alertthresholdtuningv2 after the deploy.",
    "secret-guard-shapes-a4075cf2ac5def14\nfeat/secret-guard-shapes",
  ])("leaves ordinary hyphenated identifiers alone: %s", (text) => {
    expect(guard("claude", toolEvent({ stdout: text }))).toBeUndefined();
    expect(guard("claude", promptEvent(text))).toBeUndefined();
  });

  test("redacts both Metabase session cookies in a copied request and keeps the rest", () => {
    const values = [`${body(8)}-${body(4)}-${body(4)}-${body(4)}-${body(12)}`, body(36)];
    const cookie = [`metabase${"."}SESSION=${values[0]}`, `metabase${"."}DEVICE=${values[1]}`].join("; ");
    const decision = guard("claude", toolEvent({ stdout: `curl 'https://metabase.example.com/api/user/current' -b '${cookie}; theme=dark'` }))!;
    const output = JSON.stringify(decision.hookSpecificOutput);
    for (const value of values) expect(output).not.toContain(value);
    expect(output).toContain("[redacted Metabase session cookie]; theme=dark");
  });

  test.each([
    ["a quoted cookie", (value: string) => `Cookie: metabase${"."}SESSION="${value}"; theme=dark`],
    ["a JSON-escaped quoted cookie", (value: string) => JSON.stringify({ header: `metabase${"."}DEVICE="${value}"` })],
  ])("finds a Metabase session cookie in %s, in a prompt and in tool output", (_, shape) => {
    const value = `${body(8)}-${body(4)}-${body(4)}-${body(4)}-${body(12)}`;
    expect(guard("claude", promptEvent(shape(value)))?.decision).toBe("block");
    const decision = guard("claude", toolEvent({ stdout: shape(value) }))!;
    expect(JSON.stringify(decision)).toContain("[redacted Metabase session cookie]");
    expect(JSON.stringify(decision)).not.toContain(value);
  });

  const metabaseSession = `${body(8)}-${body(4)}-${body(4)}-${body(4)}-${body(12)}`;
  const cookieKey = `metabase${"."}SESSION`;

  test.each([
    ["a cookie map", { cookies: { [cookieKey]: metabaseSession, theme: "dark" } }, { cookies: { [cookieKey]: "[redacted Metabase session cookie]", theme: "dark" } }],
    ["a browser cookie list", { cookies: [{ name: cookieKey, value: metabaseSession, domain: "metabase.example.com" }] }, { cookies: [{ name: cookieKey, value: "[redacted Metabase session cookie]", domain: "metabase.example.com" }] }],
  ])("redacts a Metabase session cookie held in %s and keeps its name", (_, structuredContent, redacted) => {
    expect(guard("claude", toolEvent({ structuredContent }))!.hookSpecificOutput).toMatchObject({ updatedToolOutput: { structuredContent: redacted } });
    expect(guard("codex", toolEvent({ structuredContent }))?.decision).toBe("block");
  });

  test.each([
    ["a serialized cookie map", JSON.stringify({ [cookieKey]: metabaseSession })],
    ["a serialized browser cookie", JSON.stringify([{ name: cookieKey, value: metabaseSession }])],
    ["a JSON-escaped serialized cookie", JSON.stringify({ stdout: JSON.stringify({ name: cookieKey, value: metabaseSession }) })],
    ["a pretty-printed browser cookie list", JSON.stringify([{ name: cookieKey, value: metabaseSession }], null, 2)],
    ["a browser cookie with properties between its name and value", JSON.stringify([{ name: cookieKey, domain: "metabase.example.com", path: "/", httpOnly: true, value: metabaseSession }], null, 2)],
    ["a browser cookie whose value comes before its name", JSON.stringify([{ domain: "metabase.example.com", value: metabaseSession, path: "/", name: cookieKey }], null, 2)],
    ["a browser cookie with a long path", JSON.stringify([{ name: cookieKey, path: `/${"p".repeat(4000)}`, value: metabaseSession }], null, 2)],
    ["a browser cookie with a nested partition key", JSON.stringify([{ name: cookieKey, partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: false }, value: metabaseSession }])],
    ["a browser cookie with a nested partition key, value first", JSON.stringify([{ value: metabaseSession, partitionKey: { topLevelSite: "https://example.com" }, path: `/${"p".repeat(4000)}`, name: cookieKey }], null, 2)],
    ["a browser cookie after another cookie", JSON.stringify([{ name: "theme", value: "dark" }, { name: cookieKey, value: metabaseSession }], null, 2)],
    ["a JavaScript cookie literal", `await context.addCookies([{ name: '${cookieKey}', value: '${metabaseSession}', domain: 'metabase.example.com' }]);`],
    ["a YAML cookie list", `cookies:\n  - name: ${cookieKey}\n    domain: metabase.example.com\n    value: ${metabaseSession}\n`],
    ["a Netscape cookies.txt line", `metabase.example.com\tFALSE\t/\tTRUE\t0\t${cookieKey}\t${metabaseSession}\n`],
    ["a JavaScript cookie whose path holds a brace", `{ name: '${cookieKey}', path: '/{', value: '${metabaseSession}' }`],
    ["a YAML cookie whose path holds a brace", `- name: ${cookieKey}\n  path: '/{'\n  value: ${metabaseSession}\n`],
    ["a JSON cookie with an escaped backslash before a brace", JSON.stringify([{ name: cookieKey, path: "\\", note: "{", value: metabaseSession }])],
    ["a JSON-escaped pretty-printed cookie", JSON.stringify({ stdout: JSON.stringify([{ name: cookieKey, secure: true, value: metabaseSession }], null, 2) })],
    ["a browser cookie whose path spells a name key", JSON.stringify([{ name: cookieKey, path: "/name: test", value: metabaseSession }])],
    ["a JavaScript cookie whose path spells a value key and a brace", `{ name: '${cookieKey}', path: '/value: placeholder/{', value: '${metabaseSession}' }`],
    ["a JSON cookie with a repeated name key", `{"name":"${cookieKey}","value":"${metabaseSession}","name":"theme"}`],
    ["a JSON cookie with a repeated value key", `{"name":"${cookieKey}","value":"${metabaseSession}","value":"dark"}`],
    ["a JSON cookie with wide spacing after its name key", `{"name":${" ".repeat(17)}"${cookieKey}","value":"${metabaseSession}"}`],
    ["a JSON cookie whose name is spelled with a unicode escape", `{"name":"metab\\u0061se.SESSION","value":"${metabaseSession}"}`],
    ["a YAML cookie with wide spacing after its value key", `- name: ${cookieKey}\n  value:${" ".repeat(17)}${metabaseSession}\n`],
    ["a cookie header with wide spacing", `${cookieKey}:${" ".repeat(17)}${metabaseSession}`],
  ])("finds a Metabase session cookie in %s", (_, text) => {
    expect(guard("claude", promptEvent(text))?.decision).toBe("block");
    const output = JSON.stringify(guard("claude", toolEvent({ stdout: text })));
    expect(output).toContain("[redacted Metabase session cookie]");
    expect(output).not.toContain(metabaseSession);
  });

  test.each([
    ["a JSON list", (build: string) => JSON.stringify([{ name: "build-id", value: build }, { name: cookieKey, value: metabaseSession }, { name: "trace-id", value: build }], null, 2)],
    ["a JSON list, value first", (build: string) => JSON.stringify([{ value: build, name: "build-id" }, { value: metabaseSession, partitionKey: { site: "https://example.com" }, name: cookieKey }, { value: build, name: "trace-id" }])],
    ["a JSON-escaped list", (build: string) => JSON.stringify({ stdout: JSON.stringify([{ name: "build-id", value: build }, { name: cookieKey, value: metabaseSession }, { name: "trace-id", value: build }]) })],
  ])("redacts only the Metabase cookie in %s and keeps its neighbours' long values", (_, shape) => {
    const build = "1234567890".repeat(4);
    const output = JSON.stringify(guard("claude", toolEvent({ stdout: shape(build) }))?.hookSpecificOutput);
    expect(output).not.toContain(metabaseSession);
    expect(output.split(build)).toHaveLength(3);
  });

  test.each([
    ["an escaped slash", (session: string) => session.replace("-", "\\/")],
    ["a unicode escape", (session: string) => `\\u0061${session}`],
  ])("withholds a JSON cookie whose value is spelled with %s, as the text holds no literal copy to redact", (_, spell) => {
    const spelled = spell(metabaseSession);
    for (const text of [`{"name":"${cookieKey}","value":"${spelled}"}`, `{"${cookieKey}":"${spelled}"}`]) withholds(text, spelled);
  });

  function withholds(text: string, spelled: string) {
    const decoded = Object.values(JSON.parse(text) as Record<string, string>).at(-1)!;
    expect(guard("claude", promptEvent(text))?.decision).toBe("block");
    const output = JSON.stringify(guard("claude", toolEvent({ stdout: text }))?.hookSpecificOutput);
    expect(output).toContain("[redacted Metabase session cookie]");
    expect(output).not.toContain(decoded);
    expect(output).not.toContain(JSON.stringify(spelled).slice(1, -1));
    expect(output).not.toContain(metabaseSession.slice(9));
  }

  test.each([
    ["the longer value first", (long: string, short: string) => [{ name: cookieKey, value: long }, { name: "metabase.DEVICE", value: short }]],
    ["the shorter value first", (long: string, short: string) => [{ name: "metabase.DEVICE", value: short }, { name: cookieKey, value: long }]],
  ])("redacts two cookies whose values overlap, with %s", (_, records) => {
    const tail = "Z9".repeat(12);
    const output = JSON.stringify(guard("claude", toolEvent({ stdout: JSON.stringify(records(`${metabaseSession}${tail}`, metabaseSession)) }))?.hookSpecificOutput);
    expect(output).not.toContain(metabaseSession);
    expect(output).not.toContain(tail);
  });

  test("redacts a cookie value that holds another secret's shape whole, so no part of it is left", () => {
    const head = "a1b2c3d4e5f6g7h8i9j0";
    const value = `${head}-${["xo", "xb"].join("")}-123-${"k".repeat(12)}`;
    const output = JSON.stringify(guard("claude", toolEvent({ stdout: JSON.stringify([{ name: cookieKey, value }]) }))?.hookSpecificOutput);
    expect(output).not.toContain(head);
    expect(output).toContain("[redacted Metabase session cookie]");
  });

  test("keeps the cookie's name in a cookie header", () => {
    const output = JSON.stringify(guard("claude", toolEvent({ stdout: `Cookie: ${cookieKey}=${metabaseSession}; theme=dark` }))?.hookSpecificOutput);
    expect(output).toContain(`${cookieKey}=[redacted Metabase session cookie]; theme=dark`);
  });

  test("finds a secret inside deeply nested JSON text", () => {
    const text = `${"[".repeat(20_000)}"${githubToken}"${"]".repeat(20_000)}`;
    expect(guard("claude", promptEvent(text))?.decision).toBe("block");
    expect(guard("codex", toolEvent({ stdout: text }))?.decision).toBe("block");
    expect(JSON.stringify(guard("claude", toolEvent({ stdout: text })))).not.toContain(githubToken);
  });

  test("withholds a prompt or tool output the guard cannot check", () => {
    const structuredContent = Array.from({ length: 200_000 }).reduce<unknown>((inner) => [inner], githubToken);
    expect(guard("claude", toolEvent({ structuredContent }))?.hookSpecificOutput).toMatchObject({ updatedToolOutput: "[withheld: Fleet's secret guard could not check this output]" });
    expect(guard("codex", toolEvent({ structuredContent }))?.decision).toBe("block");
    expect(guard("claude", { hook_event_name: "UserPromptSubmit", prompt: structuredContent as string })?.decision).toBe("block");
  });

  test("redacts every long value in a text that names a Metabase cookie and is not JSON", () => {
    const build = "1234567890".repeat(4);
    const output = JSON.stringify(guard("claude", toolEvent({ stdout: `- name: build-id\n  value: ${build}\n- name: ${cookieKey}\n  value: ${metabaseSession}\n` }))?.hookSpecificOutput);
    expect(output).not.toContain(metabaseSession);
    expect(output).not.toContain(build);
  });

  test.each([
    ["a named record", JSON.stringify([{ name: "build-id", value: "1234567890".repeat(4) }, { name: cookieKey, value: "<session-id>" }])],
    ["an unnamed record", JSON.stringify([{ name: cookieKey, value: "<session-id>" }, { value: "1234567890".repeat(4) }])],
    ["a JSON-escaped named record", JSON.stringify({ stdout: JSON.stringify([{ name: cookieKey, value: "<session-id>" }, { name: "build-id", value: "1234567890".repeat(4) }]) })],
  ])("leaves a placeholder cookie record alone when %s next to it holds a long value", (_, text) => {
    expect(guard("claude", promptEvent(text))).toBeUndefined();
    expect(guard("claude", toolEvent({ stdout: text }))).toBeUndefined();
  });

  test.each([
    `Set the ${cookieKey}=<session-id> cookie first.`,
    `curl -b "${cookieKey}=$METABASE_SESSION" https://metabase.example.com`,
    `Copy ${cookieKey}=YOUR_SESSION_TOKEN_HERE from the browser.`,
    JSON.stringify({ [cookieKey]: "<redacted>" }),
    JSON.stringify([{ name: cookieKey, value: "<session-id>" }], null, 2),
    `username: ${cookieKey}\nvalue: see the browser`,
  ])("leaves a Metabase cookie placeholder alone: %s", (text) => {
    expect(guard("claude", promptEvent(text))).toBeUndefined();
    expect(guard("claude", toolEvent({ stdout: text, structuredContent: { [cookieKey]: "<redacted>" } }))).toBeUndefined();
  });

  test.each([
    ["an added diff line", `diff --git a/token b/token\n@@ -0,0 +1 @@\n+${coderToken}\n`, "+[redacted Coder session token]"],
    ["a removed diff line", `@@ -1 +0,0 @@\n-${coderToken}\n`, "-[redacted Coder session token]"],
    ["a coloured diff line", `\x1b[32m+${coderToken}\x1b[m\n`, "+[redacted Coder session token]"],
    ["a JSON-escaped diff line", `{"stdout":"@@ -1 +1 @@\\n+${coderToken}\\n"}`, "+[redacted Coder session token]"],
  ])("redacts a Coder session token on %s and keeps the marker", (_, stdout, kept) => {
    const output = JSON.stringify(guard("claude", toolEvent({ stdout }))?.hookSpecificOutput);
    expect(output).toContain(kept);
    expect(output).not.toContain(coderToken);
  });

  test.each(["claude", "codex"] as const)("%s guard messages point at request_secret file delivery and fleet secret put --file", (provider) => {
    const decision = guard(provider, toolEvent({ stdout: githubToken }))!;
    for (const reason of [guard(provider, promptEvent(`key: ${githubToken}`))!.reason, decision.reason ?? (decision.hookSpecificOutput as { additionalContext: string }).additionalContext]) {
      expect(reason).toContain("`request_secret`");
      expect(reason).toContain("file delivery");
      expect(reason).toContain("`fleet secret put --file");
    }
  });

  test("Claude does not echo a blocked prompt back into the chat", () => {
    expect(guard("claude", promptEvent(`key: ${githubToken}`))?.hookSpecificOutput).toEqual({ hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true });
  });

  test("Codex withholds tool output that carries a secret, even as a property name", () => {
    for (const output of [{ stdout: `GITHUB_TOKEN=${githubToken}\nHOME=/home/coder` }, { structuredContent: { [githubToken]: "owner" } }]) {
      const decision = guard("codex", toolEvent(output))!;
      expect(decision.decision).toBe("block");
      expect(decision.reason).toContain("request_secret");
      expect(JSON.stringify(decision)).not.toContain(githubToken);
    }
  });

  test("Claude gets the tool output in the same shape with only the secret redacted", () => {
    const decision = guard("claude", toolEvent({ stdout: `GITHUB_TOKEN=${githubToken}\nHOME=/home/coder`, structuredContent: { [githubToken]: githubToken } }))!;
    expect(decision.decision).toBeUndefined();
    expect(decision.hookSpecificOutput).toMatchObject({
      updatedToolOutput: { stdout: "GITHUB_TOKEN=[redacted GitHub token]\nHOME=/home/coder", structuredContent: { "[redacted GitHub token]": "[redacted GitHub token]" } },
    });
    expect(JSON.stringify(decision)).not.toContain(githubToken);
  });

  test("decides quickly on output shaped to slow the scan", () => {
    const started = performance.now();
    expect(guard("codex", toolEvent(`${"prod:".repeat(100_000)} coder_session_token=${" ".repeat(100_000)}x ${githubToken}`))?.decision).toBe("block");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("leaves clean tool output alone", () => {
    for (const provider of ["claude", "codex"] as const) expect(guard(provider, toolEvent("Exit code: 0\nOutput:\nHOME=/home/coder"))).toBeUndefined();
  });

  test("the hook runner blocks when it cannot find Bun, so no secret slips through unchecked", async () => {
    if (["/opt/homebrew/bin/bun", "/usr/local/bin/bun"].some((path) => existsSync(path))) return;
    const home = temp.make("home-");
    const bin = temp.make("bin-");
    symlinkSync(Bun.which("sh")!, join(bin, "sh"));
    const child = Bun.spawn([join(bin, "sh"), join(import.meta.dir, "run.sh"), "claude", "UserPromptSubmit"], { env: { HOME: home, PATH: bin }, stdin: new Blob(["{}"]), stderr: "pipe" });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain("Fleet hooks need Bun");
  });

  test("the secret guard names its usage for an unknown agent without waiting for its input", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "secret-guard.ts"), "gemini"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toBe("Usage: secret-guard.ts claude|codex\n");
  });

  test("points at file delivery for a secret a shell command needs", () => {
    const decision = guard("claude", toolEvent(`token ${githubToken}`))!;
    expect(JSON.stringify(decision)).toContain('delivery: \\"file\\"');
  });

  test("the hook runner blocks a secret and ignores Bun configuration in the session's working directory", async () => {
    const home = temp.make("home-");
    const hooks = join(home, ".config/fleet/hooks");
    mkdirSync(join(hooks, "UserPromptSubmit"), { recursive: true });
    for (const file of ["run.sh", "run.ts"]) symlinkSync(join(import.meta.dir, file), join(hooks, file));
    symlinkSync(join(import.meta.dir, "secret-guard.ts"), join(hooks, "UserPromptSubmit/secret-guard.ts"));
    const repository = temp.make("repo-");
    writeFileSync(join(repository, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(join(repository, "preload.ts"), `await Bun.write(${JSON.stringify(join(repository, "ran"))}, "");\n`);
    const child = Bun.spawn(["sh", join(hooks, "run.sh"), "codex", "UserPromptSubmit"], {
      cwd: repository,
      env: { ...process.env, HOME: home },
      stdin: new Blob([JSON.stringify(promptEvent(githubToken))]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).decision).toBe("block");
    expect(existsSync(join(repository, "ran"))).toBe(false);
  });
});

describe("name a model", () => {
  test("blocks a Claude subagent call that names no model", () => {
    expect(check("claude", { tool_name: "Agent", tool_input: {} })).toBe(reminder);
    expect(check("claude", { tool_name: "Task" })).toBe(reminder);
  });

  test("lets a call with a model, another tool, or Codex through", () => {
    expect(check("claude", { tool_name: "Agent", tool_input: { model: "sonnet" } })).toBeUndefined();
    expect(check("claude", { tool_name: "Bash", tool_input: {} })).toBeUndefined();
    expect(check("codex", { tool_name: "Agent", tool_input: {} })).toBeUndefined();
  });
});

describe("hook runner", () => {
  const scripted = (results: Record<string, HookResult>) => async (path: string) => results[path.split("/").pop()!]!;
  const ok = (stdout = ""): HookResult => ({ code: 0, stdout, stderr: "" });
  const dirWith = (...names: string[]) => {
    const dir = temp.make("hooks-");
    for (const name of names) writeFileSync(join(dir, name), "");
    mkdirSync(join(dir, "nested.ts"));
    return dir;
  };

  test("runs nothing and passes when no pack added a hook", async () => {
    expect(await dispatch(join(temp.make("hooks-"), "PostToolUse"), "claude", "{}")).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  const suppress = { decision: "block", reason: "secret", hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true } };
  const redaction = { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "[redacted]", additionalContext: "redacted" } };

  test("blocks with exit 2 when only a plain hook blocks", async () => {
    const run = scripted({ "a.ts": ok("context"), "b.ts": { code: 2, stdout: "", stderr: "no" }, "c.ts": ok() });
    expect(await dispatch(dirWith("c.ts", "a.ts", "b.ts", "notes.md", "a.test.ts"), "claude", "{}", run)).toEqual({ code: 2, stdout: "", stderr: "no" });
  });

  test("keeps the secret guard's prompt suppression when another hook also blocks", async () => {
    const run = scripted({ "a.ts": { code: 2, stdout: "", stderr: "no" }, "secret-guard.ts": ok(JSON.stringify(suppress)) });
    expect(await dispatch(dirWith("a.ts", "secret-guard.ts"), "claude", "{}", run)).toEqual({ code: 0, stdout: `${JSON.stringify(suppress)}\n`, stderr: "" });
  });

  test("keeps the secret guard's redaction when another hook blocks or prints first", async () => {
    const blocked = scripted({ "a.ts": { code: 2, stdout: "", stderr: "no" }, "secret-guard.ts": ok(JSON.stringify(redaction)) });
    expect(JSON.parse((await dispatch(dirWith("a.ts", "secret-guard.ts"), "claude", "{}", blocked)).stdout)).toEqual({ decision: "block", reason: "no", ...redaction });
    const printed = scripted({ "a.ts": ok("some context"), "secret-guard.ts": ok(JSON.stringify(redaction)) });
    expect(JSON.parse((await dispatch(dirWith("a.ts", "secret-guard.ts"), "claude", "{}", printed)).stdout)).toEqual(redaction);
  });

  test("keeps the first decision when a later hook fails, and reports the failure", async () => {
    const run = scripted({ "a.ts": { code: 1, stdout: "", stderr: "boom" }, "b.ts": ok('{"decision":"block"}'), "c.ts": ok('{"other":true}') });
    expect(await dispatch(dirWith("a.ts", "b.ts", "c.ts"), "codex", "{}", run)).toEqual({ code: 0, stdout: '{"decision":"block"}\n', stderr: "fleet hook a.ts: boom\n" });
  });

  const hooksPrinting = (answers: Record<string, unknown>) => {
    const dir = temp.make("hooks-");
    for (const [name, answer] of Object.entries(answers)) writeFileSync(join(dir, name), `console.log(${JSON.stringify(JSON.stringify(answer))});\n`);
    return dir;
  };
  const preToolUse = (fields: Record<string, string>) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });

  test("a guard's deny wins over an earlier hook's context and a later allow, and every context reaches the agent", async () => {
    const dir = hooksPrinting({
      "a-recall.ts": preToolUse({ additionalContext: "A note about this command." }),
      "b-allow.ts": preToolUse({ permissionDecision: "allow", permissionDecisionReason: "fine" }),
      "c-guard.ts": preToolUse({ permissionDecision: "deny", permissionDecisionReason: "Fleet blocked this command." }),
      "d-recall.ts": preToolUse({ additionalContext: "Another note." }),
    });
    const answer = JSON.parse((await dispatch(dir, "claude", "{}")).stdout);
    expect(answer.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Fleet blocked this command.",
      additionalContext: "A note about this command.\n\nAnother note.",
    });
  });

  test("a later hook cannot replace the secret guard's redaction", async () => {
    const dir = hooksPrinting({
      "secret-guard.ts": { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "[redacted]" } },
      "z-echo.ts": { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "the raw output", additionalContext: "echoed" } },
    });
    expect(JSON.parse((await dispatch(dir, "claude", "{}")).stdout).hookSpecificOutput).toEqual({ hookEventName: "PostToolUse", updatedToolOutput: "[redacted]", additionalContext: "echoed" });
  });

  test("asking the person wins over an allow on Claude, and becomes a deny on Codex, which cannot ask", async () => {
    const dir = hooksPrinting({
      "a-allow.ts": { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "fine", updatedInput: { command: "echo rewritten" } } },
      "b-ask.ts": preToolUse({ permissionDecision: "ask", permissionDecisionReason: "Check this one." }),
    });
    expect(JSON.parse((await dispatch(dir, "claude", "{}")).stdout).hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Check this one.", updatedInput: { command: "echo rewritten" } });
    const codex = JSON.parse((await dispatch(dir, "codex", "{}")).stdout).hookSpecificOutput;
    expect(codex).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("Check this one.") });
  });

  test("a deny wins a permission request, with its message", async () => {
    const permission = (decision?: Record<string, unknown>) => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", ...(decision ? { decision } : {}) } });
    const dir = hooksPrinting({ "a-note.ts": permission(), "b-allow.ts": permission({ behavior: "allow" }), "c-deny.ts": permission({ behavior: "deny", message: "Not this one." }) });
    for (const provider of ["claude", "codex"]) {
      expect(JSON.parse((await dispatch(dir, provider, "{}")).stdout).hookSpecificOutput).toEqual({ hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Not this one." } });
    }
  });

  test("a block without a reason keeps another hook's deny reason, or says that a Fleet hook blocked the call", async () => {
    const withDeny = hooksPrinting({ "a-block.ts": { decision: "block", hookSpecificOutput: { hookEventName: "PreToolUse" } }, "b-guard.ts": preToolUse({ permissionDecision: "deny", permissionDecisionReason: "Fleet blocked this command." }) });
    expect(JSON.parse((await dispatch(withDeny, "codex", "{}")).stdout).hookSpecificOutput.permissionDecisionReason).toBe("Fleet blocked this command.");
    const alone = hooksPrinting({ "a-block.ts": { decision: "block", reason: " ", hookSpecificOutput: { hookEventName: "PreToolUse" } } });
    expect(JSON.parse((await dispatch(alone, "codex", "{}")).stdout).hookSpecificOutput.permissionDecisionReason).toBe("A Fleet hook blocked this tool call.");
  });

  test("no hook's context can carry a secret back to the agent", async () => {
    const dir = hooksPrinting({
      "secret-guard.ts": { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "[redacted]" } },
      "z-echo.ts": { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `The output said ${githubToken}.` } },
    });
    for (const provider of ["claude", "codex"]) {
      const { stdout } = await dispatch(dir, provider, "{}");
      expect(stdout).not.toContain(githubToken);
      expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toBe("The output said [redacted GitHub token].");
    }
  });

  test("a deny drops another hook's rewritten input, so the original call does not run", async () => {
    const dir = hooksPrinting({
      "a-guard.ts": preToolUse({ permissionDecision: "deny", permissionDecisionReason: "Fleet blocked this command." }),
      "b-rewrite.ts": { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "echo rewritten" } } },
    });
    expect(JSON.parse((await dispatch(dir, "codex", "{}")).stdout).hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Fleet blocked this command." });
  });

  test("a plain block of a tool call wins over another hook's allow and rewrite", async () => {
    const rewrite = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "echo rewritten" } } };
    const denied = { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Blocked by policy." };
    const jsonBlock = hooksPrinting({ "a-block.ts": { decision: "block", reason: "Blocked by policy.", hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "note" } }, "b-rewrite.ts": rewrite });
    expect(JSON.parse((await dispatch(jsonBlock, "codex", "{}")).stdout).hookSpecificOutput).toEqual({ ...denied, additionalContext: "note" });
    const exitBlock = scripted({ "a-block.ts": { code: 2, stdout: "", stderr: "Blocked by policy.\n" }, "b-rewrite.ts": ok(JSON.stringify(rewrite)) });
    expect(JSON.parse((await dispatch(dirWith("a-block.ts", "b-rewrite.ts"), "codex", "{}", exitBlock)).stdout).hookSpecificOutput).toEqual(denied);
    const contextOnly = scripted({ "a-block.ts": { code: 2, stdout: "", stderr: "Blocked by policy.\n" }, "b-note.ts": ok(JSON.stringify(preToolUse({ additionalContext: "note" }))) });
    expect(JSON.parse((await dispatch(dirWith("a-block.ts", "b-note.ts"), "codex", "{}", contextOnly)).stdout).hookSpecificOutput).toEqual({ ...denied, additionalContext: "note" });
  });

  test("an earlier hook cannot turn off the secret guard's prompt suppression", async () => {
    const run = scripted({ "a-note.ts": ok(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: false, additionalContext: "note" } })), "secret-guard.ts": ok(JSON.stringify(suppress)) });
    expect(JSON.parse((await dispatch(dirWith("a-note.ts", "secret-guard.ts"), "claude", "{}", run)).stdout).hookSpecificOutput.suppressOriginalPrompt).toBe(true);
  });

  test("fails without a decision when a hook fails", async () => {
    const run = scripted({ "a.ts": { code: 1, stdout: "", stderr: "" } });
    expect(await dispatch(dirWith("a.ts"), "codex", "{}", run)).toEqual({ code: 1, stdout: "", stderr: "fleet hook a.ts: exit 1\n" });
  });
});
