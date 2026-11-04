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
];

const promptEvent = (text: string): HookEvent => ({ hook_event_name: "UserPromptSubmit", prompt: text });
const toolEvent = (tool_response: unknown): HookEvent => ({ hook_event_name: "PostToolUse", tool_response });
const [, githubToken] = fakesBuiltAtRuntime[3];
const [, convexKey] = fakesBuiltAtRuntime.find(([kind]) => kind === "Convex deploy key")!;

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
    expect(guard("codex", toolEvent(`${"prod:".repeat(100_000)} ${githubToken}`))?.decision).toBe("block");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("leaves clean tool output alone", () => {
    for (const provider of ["claude", "codex"] as const) expect(guard(provider, toolEvent("Exit code: 0\nOutput:\nHOME=/home/coder"))).toBeUndefined();
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

  test("returns the first block and stops", async () => {
    const run = scripted({ "a.ts": ok('{"x":1}'), "b.ts": { code: 2, stdout: "", stderr: "no" }, "c.ts": ok() });
    expect(await dispatch(dirWith("c.ts", "a.ts", "b.ts", "notes.md", "a.test.ts"), "claude", "{}", run)).toEqual({ code: 2, stdout: "", stderr: "no" });
  });

  test("keeps the first decision when a later hook fails, and reports the failure", async () => {
    const run = scripted({ "a.ts": { code: 1, stdout: "", stderr: "boom" }, "b.ts": ok('{"decision":"block"}'), "c.ts": ok('{"other":true}') });
    expect(await dispatch(dirWith("a.ts", "b.ts", "c.ts"), "codex", "{}", run)).toEqual({ code: 0, stdout: '{"decision":"block"}', stderr: "fleet hook a.ts: boom\n" });
  });

  test("fails without a decision when a hook fails", async () => {
    const run = scripted({ "a.ts": { code: 1, stdout: "", stderr: "" } });
    expect(await dispatch(dirWith("a.ts"), "codex", "{}", run)).toEqual({ code: 1, stdout: "", stderr: "fleet hook a.ts: exit 1\n" });
  });
});
