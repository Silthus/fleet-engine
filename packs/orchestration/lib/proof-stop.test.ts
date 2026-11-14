import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, spawnGit, tempDirs } from "../../../src/testing/git.ts";
import type { ShellThread } from "../../base/lib/t3/index.ts";
import { gateRecordPath, writeJson } from "../../pull-requests/lib/proof.ts";
import { hookWith, killSwitch } from "../hooks/ask-guard.ts";
import { proofStop, type Git, type ProofStopEvent, type ProofStopOptions } from "./proof-stop.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const repository = "acme/widgets";
type Pr = NonNullable<ShellThread["pullRequests"]>[number];
const pr = (number: number, headBranch: string, fields: Partial<Pr> = {}): Pr =>
  ({ repository, number, url: `https://github.com/${repository}/pull/${number}`, snapshot: { state: "open", headBranch }, ...fields });

const gitWithTestConfig: Git = async (cwd, args) => {
  const child = Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout: stdout.trim() };
};
const loneLane = { pid: 30, table: async () => "1 0 t3\n20 1 claude\n30 20 bun\n" };

async function lane() {
  const checkout = temp.make("lane-");
  const home = temp.make("home-");
  mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
  writeFileSync(join(home, ".local/state/fleet/settings.json"), JSON.stringify({ "guards.person": "Robin" }));
  const git =(...args: string[]) => spawnGit(checkout, ...args);
  await git("init", "-q", "-b", "main");
  await git("remote", "add", "origin", `git@github.com:${repository}.git`);
  writeFileSync(join(checkout, "app.ts"), "one\n");
  await git("add", "app.ts");
  await git("commit", "-q", "-m", "base");
  await git("checkout", "-q", "-b", "feat");
  const commit = async (content: string) => {
    writeFileSync(join(checkout, "app.ts"), content);
    await git("commit", "-q", "-am", content);
    return git("rev-parse", "HEAD");
  };
  const push = async (branch = "feat") => {
    await git("update-ref", `refs/remotes/origin/${branch}`, `refs/heads/${branch}`);
    return git("rev-parse", `refs/remotes/origin/${branch}`);
  };
  const head = await commit("two\n");
  await push();
  const gate = (commit: string, code: number, reason = code === 0 ? "pass" : "head: not pushed", number = 7, name = repository) =>
    writeJson(gateRecordPath(home, { repository: name, pr: number, commit }), { code, reason });
  const thread = (fields: Partial<ShellThread> = {}): ShellThread =>
    ({ id: "mcp:lane", title: "Lane", projectId: "p", status: "idle", worktreePath: checkout, pullRequests: [pr(7, "feat")], ...fields });
  const event: ProofStopEvent = { cwd: checkout, last_assistant_message: "Done." };
  const check = (threads: ShellThread[] = [thread()], fields: Partial<ProofStopEvent> = {}, options: Partial<ProofStopOptions> = {}) =>
    proofStop({ ...event, ...fields }, { home, threadId: "lane", shell: async () => ({ threads }), git: gitWithTestConfig, processes: loneLane, ...options });
  return { checkout, home, git, commit, push, head, gate, thread, check };
}

const reasonOf = async (answer: Promise<{ reason: string } | undefined>) => (await answer)?.reason;

describe("the Stop proof check blocks a lane that owns an open PR", () => {
  test("when no gate run is recorded at the pushed head, naming the gate command for that layer", async () => {
    const { head, check } = await lane();
    const answer = await check();
    expect(answer?.decision).toBe("block");
    expect(answer?.reason).toContain(`${repository}#7 has no gate run at its pushed head ${head.slice(0, 7)}`);
    expect(answer?.reason).toContain(`fleet proof gate --repo ${repository} --pr 7 --commit ${head}`);
    expect(answer?.reason).toContain("ask with the question tool or end with a `NEEDS_HUMAN:` line");
  });

  test("when it has a local commit past the pushed head, even though the pushed head passed", async () => {
    const { head, gate, commit, check } = await lane();
    await gate(head, 0);
    const local = await commit("three\n");
    const reason = await reasonOf(check());
    expect(reason).toContain(`${repository}#7 has 1 local commit(s) on feat past its pushed head. Run git push origin feat, then fleet proof gate --repo ${repository} --pr 7 --commit ${local}`);
  });

  test("when a tracked file has uncommitted changes, but not for an untracked file", async () => {
    const { head, gate, checkout, check } = await lane();
    await gate(head, 0);
    writeFileSync(join(checkout, "notes.txt"), "scratch\n");
    expect(await check()).toBeUndefined();
    writeFileSync(join(checkout, "app.ts"), "edited\n");
    expect(await reasonOf(check())).toContain(`${repository}#7 has uncommitted changes to tracked files on feat`);
  });

  test("when its worktree has a detached HEAD past the pushed head", async () => {
    const { head, gate, git, commit, check } = await lane();
    await gate(head, 0);
    await git("checkout", "-q", "--detach");
    const detached = await commit("three\n");
    const reason = await reasonOf(check());
    expect(reason).toContain(`this worktree has a detached HEAD ${detached.slice(0, 7)} past its pushed head`);
    expect(reason).toContain(`git push origin HEAD:refs/heads/feat, then run fleet proof gate --repo ${repository} --pr 7 --commit ${detached}`);
  });

  test("when the last gate run at the pushed head failed, quoting its reason", async () => {
    const { head, gate, check } = await lane();
    await gate(head, 1, "ci: red, required failing: test");
    const reason = await reasonOf(check());
    expect(reason).toContain(`the last gate run at its pushed head ${head.slice(0, 7)} exited 1: ci: red, required failing: test. Fix it, then run fleet proof gate --repo ${repository} --pr 7 --commit ${head} again`);
  });

  test("when the last gate run left only gaps, naming the agent's tier decision and the question tool", async () => {
    const { head, gate, check } = await lane();
    await gate(head, 3, "ci: gap recorded");
    const reason = await reasonOf(check());
    expect(reason).toContain("exited 3: ci: gap recorded");
    expect(reason).toContain("fleet decision record --mark 🤖");
    expect(reason).toContain("ask Robin with the question tool");
  });

  test("on a stack, naming the lower layer that owes its gate and listing the others", async () => {
    const { head, gate, git, commit, push, thread, check } = await lane();
    await git("checkout", "-q", "-b", "feat-2");
    const upper = await commit("upper\n");
    await push("feat-2");
    await gate(upper, 0, "pass", 8);
    const stack = [thread({ pullRequests: [pr(7, "feat"), pr(8, "feat-2"), pr(9, "feat-3")] })];
    await git("branch", "feat-3");
    await push("feat-3");
    const reason = await reasonOf(check(stack));
    expect(reason).toContain(`fleet proof gate --repo ${repository} --pr 7 --commit ${head}`);
    expect(reason).toContain(`Also owed: ${repository}#9.`);
    expect(reason).not.toContain(`#8`);
  });

  test("a fork owns its PRs, unlike a subagent", async () => {
    const { thread, check } = await lane();
    const root: ShellThread = { id: "mcp:root", title: "Root", projectId: "p", status: "idle" };
    expect(await check([root, thread({ lineage: { parentThreadId: "mcp:root", rootThreadId: "mcp:root", relationshipToParent: "fork" } })])).toBeDefined();
    expect(await check([root, thread({ lineage: { parentThreadId: "mcp:root", rootThreadId: "mcp:root", relationshipToParent: "subagent" } })])).toBeUndefined();
  });

  test("whose gate run named the repository in other letter case", async () => {
    const { head, gate, check } = await lane();
    await gate(head, 0, "pass", 7, "Acme/Widgets");
    expect(await check()).toBeUndefined();
  });

  test("a plain background command, a Claude background shell, or a settled watch is no wait", async () => {
    const { head, thread, check } = await lane();
    expect(await check([thread({ pendingBackgroundTasks: [{ kind: "command" }] })])).toBeDefined();
    expect(await check([thread()], { background_tasks: [{ id: "b1", type: "shell", status: "running" }] })).toBeDefined();
    expect(await check([thread({ pullRequests: [pr(7, "feat", { watch: { headSha: head, passed: true } })] })])).toBeDefined();
    expect(await check([thread({ pullRequests: [pr(7, "feat", { watch: { headSha: head, failedChecks: ["test"] } })] })])).toBeDefined();
  });
});

describe("the Stop proof check lets the stop pass", () => {
  test("when a gate run at the pushed head exited 0 and nothing local is past it", async () => {
    const { head, gate, check } = await lane();
    await gate(head, 0);
    expect(await check()).toBeUndefined();
  });

  test.each<[string, (setup: Awaited<ReturnType<typeof lane>>) => Promise<unknown>]>([
    ["on a stop a stop hook already continued", ({ check }) => check(undefined, { stop_hook_active: true })],
    ["outside a T3 thread", ({ check }) => check(undefined, {}, { threadId: undefined })],
    ["without the event's cwd", ({ check }) => check(undefined, { cwd: undefined })],
    ["while a question card is pending", ({ thread, check }) => check([thread({ pendingRuntimeRequest: { id: "r1", kind: "user_input" } })])],
    ["on a NEEDS_HUMAN: last line", ({ check }) => check(undefined, { last_assistant_message: "Parked.\n\n`NEEDS_HUMAN: pick a mode, from Robin`" })],
    ["while a child task runs", ({ thread, check }) => check([thread({ pendingBackgroundTasks: [{ kind: "task", childThreadId: "mcp:child" }] })])],
    ["while the lane awaits a shell command", ({ thread, check }) => check([thread({ pendingBackgroundTasks: [{ kind: "command", awaited: true }] })])],
    ["while the lane waits on another thread", ({ thread, check }) => check([thread({ blockedOnThreadWait: true })])],
    ["while a Claude subagent or monitor runs", ({ check }) => check(undefined, { background_tasks: [{ id: "a1", type: "agent", status: "running" }] })],
    ["while a Claude wake-up is scheduled", ({ check }) => check(undefined, { session_crons: [{ id: "c1" }] })],
    ["while the watch waits on CI at the pushed head", ({ head, thread, check }) => check([thread({ pullRequests: [pr(7, "feat", { watch: { headSha: head } })] })])],
    ["while the watch has not read the pushed head yet", ({ thread, check }) => check([thread({ pullRequests: [pr(7, "feat", { watch: { headSha: "0".repeat(40), passed: true } })] })])],
    ["while a run waits on an approval", ({ head, thread, check }) => check([thread({ pullRequests: [pr(7, "feat", { watch: { headSha: head, failedChecks: ["test"], awaitingApproval: ["deploy"] } })] })])],
    ["for a merged PR", ({ thread, check }) => check([thread({ pullRequests: [pr(7, "feat", { snapshot: { state: "merged", headBranch: "feat" } })] })])],
    ["for a PR in another repository", ({ thread, check }) => check([thread({ pullRequests: [{ ...pr(7, "feat"), url: "https://github.com/acme/other/pull/7" }] })])],
    ["for a PR whose head branch has no remote ref here", ({ thread, check }) => check([thread({ pullRequests: [pr(7, "elsewhere")] })])],
    ["in a subagent thread whose root is open", ({ thread, check }) => check([
      { id: "mcp:root", title: "Root", projectId: "p", status: "idle" },
      thread({ lineage: { parentThreadId: "mcp:root", rootThreadId: "mcp:root" } }),
    ])],
    ["in a thread delegated from another machine", ({ thread, check }) => check([thread({ delegatedFrom: { environmentId: "env-2", threadId: "mcp:parent" } })])],
    ["in a model session another session started", ({ check }) => check(undefined, {}, { processes: { pid: 40, table: async () => "1 0 t3\n20 1 claude\n30 20 bash\n35 30 codex\n40 35 bun\n" } })],
    ["when T3 cannot be read", ({ check }) => check(undefined, {}, { shell: async () => { throw new Error("T3 is down"); } })],
    ["when the process table cannot be read", ({ check }) => check(undefined, {}, { processes: { pid: 1, table: async () => { throw new Error("no ps"); } } })],
    ["when git fails", ({ check }) => check(undefined, {}, { git: async () => ({ code: 128, stdout: "" }) })],
    ["when the gate record is malformed", async ({ head, home, check }) => {
      await writeJson(gateRecordPath(home, { repository, pr: 7, commit: head }), { code: "zero" });
      return check();
    }],
    ["when T3 answers after the deadline", ({ check }) => check(undefined, {}, { shell: () => new Promise(() => {}), deadline: async () => {} })],
  ])("%s", async (_, stop) => {
    expect(await stop(await lane())).toBeUndefined();
  });
});

describe("the installed Stop hook", () => {
  test("runs the proof check after the prose guard, which wins when the last message asks in prose", async () => {
    const { home, checkout, thread } = await lane();
    const routed = hookWith(() => async () => ({ threads: [thread()] }), { threadId: "lane", topLevel: async () => true, git: gitWithTestConfig, processes: loneLane });
    const transcript = join(temp.make("transcript-"), "session.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "Ship it" } })}\n`);
    const stopOn = async (message: string) => JSON.parse((await routed("claude", async () => JSON.stringify({ transcript_path: transcript, cwd: checkout, last_assistant_message: message }), home)).stdout).reason as string;
    expect(await stopOn("Both layers are green. Should I merge the bottom layer first?")).toContain("asks Robin a decision in prose");
    expect(await stopOn("Pushed the fix.")).toContain("Fleet blocked this stop: your PR is not proven.");
  });

  test("lets an unproven stop pass while the kill switch exists, and still runs the prose guard", async () => {
    const { home, checkout, thread } = await lane();
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, killSwitch), "");
    const routed = hookWith(() => async () => ({ threads: [thread()] }), { threadId: "lane", topLevel: async () => true, git: gitWithTestConfig, processes: loneLane });
    const transcript = join(temp.make("transcript-"), "session.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "Ship it" } })}\n`);
    const stopOn = (message: string) => routed("codex", async () => JSON.stringify({ transcript_path: transcript, cwd: checkout, last_assistant_message: message }), home);
    expect(await stopOn("Pushed the fix.")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect((await stopOn("Should I merge the bottom layer first?")).stdout).toContain("asks Robin a decision in prose");
  });

  test("reads the final message from a Codex transcript when the event names none, so a NEEDS_HUMAN: park passes", async () => {
    const { home, checkout, thread } = await lane();
    const routed = hookWith(() => async () => ({ threads: [thread()] }), { threadId: "lane", topLevel: async () => true, git: gitWithTestConfig, processes: loneLane });
    const transcript = join(temp.make("transcript-"), "session.jsonl");
    const lines = [
      { type: "event_msg", payload: { type: "user_message", message: "Ship it" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Parked.\n\nNEEDS_HUMAN: pick the next mode, from Robin" }] } },
    ];
    writeFileSync(transcript, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    expect(await routed("codex", async () => JSON.stringify({ transcript_path: transcript, cwd: checkout }), home)).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
