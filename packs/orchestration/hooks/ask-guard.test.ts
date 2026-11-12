import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AvailableSource } from "../../../src/pack/types.ts";
import { tempDirs } from "../../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../../src/testing/packs.ts";
import { dispatch } from "../../base/hooks/run.ts";
import { asksForDecision } from "../lib/prose-question.ts";
import { guardStop, hook, type IsTopLevel, type StopEvent } from "./ask-guard.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const topLevel: IsTopLevel = async (threadId) => threadId === "top";
const claudePrompt = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const claudeSays = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const claudeAsks = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: {} }] } };
const claudeSaysThenAsks = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }, { type: "tool_use", id: "t3", name: "AskUserQuestion", input: {} }] } });
const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } };
const codexPrompt = (text: string) => ({ type: "event_msg", payload: { type: "user_message", message: text } });
const codexSays = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const codexAsks = { type: "response_item", payload: { type: "function_call", name: "request_user_input", arguments: "{}" } };

function transcript(...lines: object[]) {
  const path = join(temp.make("transcript-"), "session.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

function home(person?: string) {
  const dir = temp.make("home-");
  if (person) {
    mkdirSync(join(dir, ".local/state/fleet"), { recursive: true });
    writeFileSync(join(dir, ".local/state/fleet/settings.json"), JSON.stringify({ "guards.person": person }));
  }
  return dir;
}

const stop = (event: StopEvent, threadId: string | undefined = "top", where = home("Robin")) => guardStop(event, where, threadId, topLevel);

describe("the prose question detector", () => {
  test.each([
    "Both PRs are green. Should I merge the bottom layer first?",
    "Which option do you prefer: A or B",
    "The stack is ready. Please send it when you're ready.",
    "The decision is on the map, ticket 4.",
    "Done with the review.\n\n**Want me to open the follow-up?**",
    "Let me know whether the timeout of 30 s is fine.",
    "I need your approval to delete the old branch.",
    "Three options:\n1. Retry\n2. Skip\n3. Revert\n\nWhich one?",
  ])("finds a decision for the person: %s", (message) => {
    expect(asksForDecision(message)).toBe(true);
  });

  test.each([
    "Merged both PRs. Nothing needs your decision.",
    "All checks pass and the PR is ready.",
    "The test asks:\n```\nwhy does it fail?\n```\nIt failed on a missing fixture, which I added.",
    "> Should we keep the flag?\n\nThe reviewer asked that; I kept the flag, as the spec says.",
    "Why did it fail? A missing fixture. I added it, and the suite passes now. Pushed the fix to the branch, and CI is green on the new head. The PR is ready for review and linked to this thread. "
      + "The next scheduled check runs tomorrow at 05:00 and needs nothing from anyone. ".repeat(10),
  ])("ignores a message that asks the person nothing: %s", (message) => {
    expect(asksForDecision(message)).toBe(false);
  });
});

describe("the ask guard", () => {
  test("blocks a top-level T3 thread once when its Claude turn ends on a prose decision, naming the person", async () => {
    const path = transcript(claudePrompt("Fix the flaky test"), claudeSays("Fixed. Should I also open the follow-up PR?"));
    const blocked = await stop({ transcript_path: path });
    expect(blocked).toEqual({ decision: "block", reason: expect.stringContaining("asks Robin a decision in prose") });
    expect(blocked!.reason).toContain("AskUserQuestion");
    expect(await stop({ transcript_path: path, stop_hook_active: true })).toBeUndefined();
  });

  test("blocks a Codex turn that ends on a prose decision", async () => {
    const path = transcript(codexPrompt("Fix it"), codexSays("Fixed. Do you want the follow-up too?"));
    expect(await stop({ transcript_path: path })).toMatchObject({ decision: "block" });
  });

  test("reads the last assistant message the event names before the transcript", async () => {
    const path = transcript(claudePrompt("Fix it"), claudeSays("Do you want the follow-up too?"));
    expect(await stop({ transcript_path: path, last_assistant_message: "Fixed and pushed." })).toBeUndefined();
    const quiet = transcript(claudePrompt("Fix it"), claudeSays("Fixed and pushed."));
    expect(await stop({ transcript_path: quiet, last_assistant_message: "Shall I merge it?" })).toMatchObject({ decision: "block" });
  });

  test("names a fallback person without settings", async () => {
    const path = transcript(claudePrompt("Fix it"), claudeSays("Shall I merge it?"));
    expect((await stop({ transcript_path: path }, "top", home()))!.reason).toContain("asks the person a decision");
  });

  test.each([
    ["Claude's question tool", [claudePrompt("Fix it"), claudeSays("Which one do you want?"), claudeAsks]],
    ["Claude's question tool in the same message", [claudePrompt("Fix it"), claudeSaysThenAsks("Which one do you want?")]],
    ["an MCP question tool", [claudePrompt("Fix it"), claudeSays("Which one do you want?"), { ...claudeAsks, message: { ...claudeAsks.message, content: [{ type: "tool_use", id: "t2", name: "mcp__t3__AskUserQuestion", input: {} }] } }]],
    ["Codex's question tool", [codexPrompt("Fix it"), codexSays("Which one do you want?"), codexAsks]],
  ])("lets the stop through when %s asks after the prose question", async (_, lines) => {
    expect(await stop({ transcript_path: transcript(...lines) })).toBeUndefined();
  });

  test("lets the stop through when the last message asks nothing", async () => {
    const path = transcript(claudePrompt("Fix it"), claudeSays("Should I fix it? Yes, the spec says so."), claudeSays("Fixed and pushed."));
    expect(await stop({ transcript_path: path })).toBeUndefined();
  });

  test.each([
    ["an earlier Claude question tool call", [claudePrompt("Fix it"), claudeAsks, toolResult, claudeSays("Asked above. Should I wait?")]],
    ["an earlier Codex question tool call", [codexPrompt("Fix it"), codexAsks, codexSays("Which one do you want?")]],
    ["a message that only names the tool", [claudePrompt("Fix it"), claudeSays('I will call request_user_input(options). "name": "AskUserQuestion". Should I merge?')]],
    ["a tool result that names the tool", [claudePrompt("Fix it"), { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: '"name": "AskUserQuestion"' }] } }, claudeSays("Should I merge?")]],
    ["a Codex call to another tool", [codexPrompt("Fix it"), codexSays("Which one do you want?"), { type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"echo request_user_input("}' } }]],
  ])("blocks a prose question that only %s precedes or names", async (_, lines) => {
    expect(await stop({ transcript_path: transcript(...lines) })).toMatchObject({ decision: "block" });
  });

  test("blocks a final message the event names even when the turn asked with the tool earlier", async () => {
    const path = transcript(claudePrompt("Fix it"), claudeAsks, toolResult);
    expect(await stop({ transcript_path: path, last_assistant_message: "Done. Should I also open the follow-up?" })).toMatchObject({ decision: "block" });
  });

  test("counts only the current turn's question tool calls", async () => {
    const path = transcript(claudePrompt("Start"), claudeAsks, toolResult, claudePrompt("Now fix it"), claudeSays("Fixed. Should I merge?"));
    expect(await stop({ transcript_path: path })).toMatchObject({ decision: "block" });
  });

  test.each([
    ["a subagent thread", "child"],
    ["a session outside T3", ""],
  ])("lets %s stop on a prose question", async (_, threadId) => {
    const path = transcript(claudePrompt("Fix it"), claudeSays("Should I merge?"));
    expect(await stop({ transcript_path: path }, threadId)).toBeUndefined();
  });

  test("lets the stop through when the transcript is missing or unreadable, or the input is not JSON", async () => {
    expect(await stop({})).toBeUndefined();
    expect(await stop({ transcript_path: join(temp.make("gone-"), "none.jsonl") })).toBeUndefined();
    expect(await hook("claude", async () => "not json", home())).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("outside T3, the installed hook finds no thread and lets the stop through", async () => {
    const path = transcript(claudePrompt("Fix it"), claudeSays("Should I merge?"));
    const saved = process.env.T3CODE_THREAD_ID;
    delete process.env.T3CODE_THREAD_ID;
    try {
      expect(await hook("claude", async () => JSON.stringify({ transcript_path: path }), home())).toEqual({ code: 0, stdout: "", stderr: "" });
    } finally {
      if (saved !== undefined) process.env.T3CODE_THREAD_ID = saved;
    }
  });
});

describe("the question guard workflow", () => {
  const plan = (workflows: Record<string, boolean> = {}, plans: "claude" | "codex" | "both" = "both") =>
    resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["pull-requests", "orchestration"], workflows, plan: plans }, devbox);

  test("installs the Stop hook by default, and the base pack routes Stop to it for Claude and Codex", () => {
    expect(plan().files.map((file) => file.target)).toContain(".config/fleet/hooks/Stop/ask-guard.ts");
    expect(plan({ "question-guard": false }).files.map((file) => file.target)).not.toContain(".config/fleet/hooks/Stop/ask-guard.ts");
    const stops = plan().config.filter((entry) => entry.key === "hooks.Stop");
    expect(stops.map((entry) => entry.provider).sort()).toEqual(["claude", "codex"]);
    for (const entry of stops) expect(JSON.stringify(entry.value)).toContain(`run.sh\\" ${entry.provider} Stop`);
  });

  test("the hook dispatcher hands the block to the agent as JSON", async () => {
    const where = home("Robin");
    const target = join(where, ".config/fleet/hooks/Stop/ask-guard.ts");
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(import.meta.dir, "ask-guard.ts"), target);
    const path = transcript(claudePrompt("Fix it"), claudeSays("Should I merge?"));
    const result = await dispatch(dirname(target), "claude", JSON.stringify({ transcript_path: path }), async (hookPath, provider, input) => {
      expect(basename(hookPath)).toBe("ask-guard.ts");
      return { code: 0, stdout: `${JSON.stringify(await guardStop(JSON.parse(input), where, "top", topLevel))}\n`, stderr: provider === "claude" ? "" : "wrong provider" };
    });
    expect(JSON.parse(result.stdout)).toEqual({ decision: "block", reason: expect.stringContaining("asks Robin") });
  });
});
