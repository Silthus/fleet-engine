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

  test("the hook runner blocks when it cannot find Bun, so no secret slips through unchecked", async () => {
    if (["/opt/homebrew/bin/bun", "/usr/local/bin/bun"].some((path) => existsSync(path))) return;
    const home = temp.make("home-");
    const bin = temp.make("bin-");
    symlinkSync(Bun.which("sh")!, join(bin, "sh"));
    const child = Bun.spawn([join(bin, "sh"), join(import.meta.dir, "run.sh"), "claude", "UserPromptSubmit"], { env: { HOME: home, PATH: bin }, stdin: new Blob(["{}"]), stderr: "pipe" });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain("Fleet hooks need Bun");
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
