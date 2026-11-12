import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShellThread } from "../../src/integrations/t3/threads.ts";
import type { LinkedThread } from "../../src/integrations/t3/environments.ts";
import { startT3Stub, ToolRefusal, type T3Stub } from "../../src/integrations/t3/testing.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { guardSettle, type SettleDeps } from "./hooks/settle-guard.ts";
import { prCommand } from "./lib/pr.ts";
import { handoverPath, threadsOwningPrs } from "./lib/pr-owners.ts";

const temp = tempDirs();
const stubs: T3Stub[] = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.stop()));
  temp.cleanup();
});

const pr = (n: number, state?: string) => ({ repository: "acme/app", number: n, url: `https://github.com/acme/app/pull/${n}`, ...(state ? { snapshot: { state } } : {}) });
const thread = (id: string, fields: Partial<ShellThread> = {}): ShellThread => ({ id, title: `Thread ${id}`, projectId: "p", status: "idle", ...fields });
const child = (id: string, root: string, fields: Partial<ShellThread> = {}) => thread(id, { lineage: { parentThreadId: root, rootThreadId: root }, ...fields });
const organize = (input: Record<string, unknown>, name = "mcp__t3-code__t3_thread_organize") => ({ tool_name: name, tool_input: input });

function homeWith(settings?: Record<string, unknown>) {
  const home = temp.make("fleet-settle-");
  if (settings) {
    mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
    writeFileSync(join(home, ".local/state/fleet/settings.json"), JSON.stringify(settings));
  }
  return home;
}

function deps(threads: ShellThread[] | undefined, states: Record<number, string | Error> = {}, self = "mcp:me"): SettleDeps & { asked: string[]; machines: (string | undefined)[] } {
  const asked: string[] = [];
  const machines: (string | undefined)[] = [];
  return {
    asked, self, machines,
    threads: async (_home, environmentId) => (machines.push(environmentId), threads),
    prState: async (url) => {
      asked.push(url);
      const state = states[Number(url.split("/").pop())] ?? "open";
      if (state instanceof Error) throw state;
      return state;
    },
  };
}

const reasonOf = (denial: Awaited<ReturnType<typeof guardSettle>>) => denial?.hookSpecificOutput.permissionDecisionReason;

describe("the settle guard", () => {
  test("refuses to settle or archive a thread that owns an open PR, under either T3 tool name, and names the person and the handover", async () => {
    const home = homeWith({ "guards.person": "Robin" });
    for (const name of ["mcp__t3-code__t3_thread_organize", "mcp__t3_code__t3_thread_organize"]) for (const action of ["settle", "archive"]) {
      const denial = await guardSettle(organize({ action }, name), home, deps([thread("mcp:me", { pullRequests: [pr(1)] })]));
      expect(denial?.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(reasonOf(denial)).toBe("Fleet blocked this settle: the thread owns open PR(s) https://github.com/acme/app/pull/1, and no other open thread links them. "
        + "Hand each over first: the thread that takes it over links it with link_pull_request, or record the handover with "
        + "`fleet pr handover --pr <PR URL> --to <thread id>`, which counts while the thread it names stays open. Or close or merge the PR. Robin can still settle the thread in T3.");
    }
  });

  test("lets other tools, other actions, and a call with no thread through without asking T3", async () => {
    const home = homeWith();
    const owner = [thread("mcp:me", { pullRequests: [pr(1)] })];
    let read = 0;
    const counting: SettleDeps = { ...deps(owner), threads: async () => (read++, owner) };
    for (const call of [
      organize({ action: "settle" }, "mcp__other__t3_thread_organize"),
      organize({ action: "settle" }, "mcp__t3-code__t3_thread_organize_all"),
      organize({ action: "pin" }),
      { tool_name: "Bash", tool_input: { command: "echo" } },
    ]) expect(await guardSettle(call, home, counting)).toBeUndefined();
    expect(await guardSettle(organize({ action: "settle" }), home, { ...counting, self: "" })).toBeUndefined();
    expect(await guardSettle({ tool_name: "mcp__t3-code__t3_thread_organize" }, home, counting)).toBeUndefined();
    expect(read).toBe(0);
  });

  test("reads the threads of the machine the call names", async () => {
    const check = deps([thread("mcp:lane", { pullRequests: [pr(2)] })]);
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: "mcp:lane", environmentId: "env-2" }), homeWith(), check))).toContain("pull/2,");
    expect(check.machines).toEqual(["env-2"]);
  });

  test("checks the thread the call names, by full or bare id, before the calling thread", async () => {
    const home = homeWith();
    const threads = [thread("mcp:me"), thread("mcp:lane", { pullRequests: [pr(2)] })];
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: "lane" }), home, deps(threads)))).toContain("pull/2,");
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: "mcp:lane" }), home, deps(threads)))).toContain("pull/2,");
    expect(await guardSettle(organize({ action: "settle" }), home, deps(threads))).toBeUndefined();
    expect(await guardSettle(organize({ action: "settle", threadId: "mcp:gone" }), home, deps(threads))).toBeUndefined();
  });

  test("counts the open children's links, not a settled child's, and lets a child whose root is open settle", async () => {
    const home = homeWith();
    const threads = [
      thread("mcp:me"),
      child("mcp:kid", "mcp:me", { pullRequests: [pr(3)] }),
      child("mcp:done", "mcp:me", { settledAt: "2026-11-01T00:00:00Z", pullRequests: [pr(4)] }),
      thread("mcp:grandkid", { lineage: { parentThreadId: "mcp:kid", rootThreadId: "mcp:me" }, pullRequests: [pr(14)] }),
    ];
    const reason = reasonOf(await guardSettle(organize({ action: "settle" }), home, deps(threads)));
    expect(reason).toContain("pull/3, https://github.com/acme/app/pull/14,");
    expect(reason).not.toContain("pull/4");
    expect(await guardSettle(organize({ action: "settle", threadId: "mcp:kid" }), home, deps(threads))).toBeUndefined();
    const orphan = [thread("mcp:me", { archivedAt: "2026-11-01T00:00:00Z" }), child("mcp:kid", "mcp:me", { pullRequests: [pr(3)] })];
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: "mcp:kid" }), home, deps(orphan)))).toContain("pull/3,");
    const parentOnly = [thread("mcp:me"), thread("mcp:kid", { lineage: { parentThreadId: "mcp:me" }, pullRequests: [pr(3)] })];
    expect(await guardSettle(organize({ action: "settle", threadId: "mcp:kid" }), home, deps(parentOnly))).toBeUndefined();
  });

  test("lets a PR go that another open thread links, under any case or a trailing slash, but not one only a closed thread links", async () => {
    const home = homeWith();
    const shared = { ...pr(5), url: "https://github.com/Acme/App/pull/5/" };
    expect(await guardSettle(organize({ action: "settle" }), home, deps([thread("mcp:me", { pullRequests: [pr(5)] }), thread("mcp:next", { pullRequests: [shared] })]))).toBeUndefined();
    for (const closed of [{ settledAt: "x" }, { archivedAt: "x" }, { deletedAt: "x" }]) {
      expect(reasonOf(await guardSettle(organize({ action: "settle" }), home, deps([thread("mcp:me", { pullRequests: [pr(5)] }), thread("mcp:old", { ...closed, pullRequests: [pr(5)] })])))).toContain("pull/5,");
    }
  });

  test("asks GitHub only about PRs T3 last saw open, lets merged and closed ones go, and holds one GitHub cannot answer for", async () => {
    const home = homeWith();
    const threads = [thread("mcp:me", { pullRequests: [pr(6, "merged"), pr(7, "closed"), pr(8, "open"), pr(9), pr(10), pr(11)] })];
    const check = deps(threads, { 8: "merged", 9: "closed", 10: new Error("gh api failed: HTTP 502\nmore"), 11: "open" });
    const reason = reasonOf(await guardSettle(organize({ action: "settle" }), home, check));
    expect(check.asked.map((url) => url.split("/").pop())).toEqual(["8", "9", "10", "11"]);
    expect(reason).toContain("open PR(s) https://github.com/acme/app/pull/10 (state unknown (gh api failed: HTTP 502)), https://github.com/acme/app/pull/11, and");
    expect(reason).not.toContain("pull/8");
  });

  async function handover(home: string, from: string | undefined, pr: string, to: string) {
    const saved = process.env.T3CODE_THREAD_ID;
    if (from === undefined) delete process.env.T3CODE_THREAD_ID; else process.env.T3CODE_THREAD_ID = from;
    const log = console.log;
    console.log = () => {};
    try {
      return await prCommand(["handover", "--pr", pr, "--to", to], home, new Date("2026-11-12T10:00:00Z"));
    } finally {
      console.log = log;
      if (saved === undefined) delete process.env.T3CODE_THREAD_ID; else process.env.T3CODE_THREAD_ID = saved;
    }
  }

  test("lets a thread settle once each open PR is handed over to an open thread, and the handover records lower-case URLs privately", async () => {
    const home = homeWith();
    const threads = [thread("mcp:me", { pullRequests: [pr(12), pr(13)] }), thread("mcp:next")];
    expect(await handover(home, "mcp:me", "https://github.com/Acme/App/pull/12", "mcp:next")).toBe(0);
    expect(readFileSync(handoverPath(home), "utf8")).toBe(`${JSON.stringify({ pr: "https://github.com/acme/app/pull/12", from: "mcp:me", to: "mcp:next", at: "2026-11-12T10:00:00.000Z" })}\n`);
    expect(statSync(handoverPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".local/state/fleet")).mode & 0o777).toBe(0o700);
    const reason = reasonOf(await guardSettle(organize({ action: "settle" }), home, deps(threads)));
    expect(reason).toContain("open PR(s) https://github.com/acme/app/pull/13, and");
    writeFileSync(handoverPath(home), `not json\n${JSON.stringify({ to: "x" })}\n${readFileSync(handoverPath(home), "utf8")}${JSON.stringify({ pr: "https://github.com/acme/app/pull/13", from: "me", to: "next", at: "x" })}\n`);
    expect(await guardSettle(organize({ action: "settle" }), home, deps(threads))).toBeUndefined();
  });

  test("holds the second settle of a handover chain until that thread hands the PR on", async () => {
    const home = homeWith();
    const x = "https://github.com/acme/app/pull/20";
    const chain = () => [
      thread("mcp:a", { settledAt: "2026-11-12T10:05:00Z", pullRequests: [pr(20)] }),
      thread("mcp:b", { pullRequests: [pr(20)] }),
      thread("mcp:c"),
    ];
    await handover(home, "mcp:a", x, "mcp:b");
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: "mcp:b" }), home, deps(chain())))).toContain("open PR(s) https://github.com/acme/app/pull/20, and");
    await handover(home, "mcp:b", x, "mcp:c");
    expect(await guardSettle(organize({ action: "settle", threadId: "mcp:b" }), home, deps(chain()))).toBeUndefined();
  });

  test.each([
    ["names a thread that does not exist", "mcp:me", "mcp:nobody"],
    ["names a settled thread", "mcp:me", "mcp:settled"],
    ["names an archived thread", "mcp:me", "mcp:archived"],
    ["names the settling thread itself", "mcp:me", "mcp:me"],
    ["another thread recorded", "mcp:other", "mcp:next"],
  ])("holds a PR whose handover %s", async (_, from, to) => {
    const home = homeWith();
    await handover(home, from, "https://github.com/acme/app/pull/21", to);
    const threads = [
      thread("mcp:me", { pullRequests: [pr(21)] }), thread("mcp:next"), thread("mcp:other"),
      thread("mcp:settled", { settledAt: "x" }), thread("mcp:archived", { archivedAt: "x" }),
    ];
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), home, deps(threads)))).toContain("pull/21,");
  });

  test("refuses the settle when T3 does not answer, and names a fallback person without settings", async () => {
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), homeWith(), deps(undefined)))).toBe("Fleet blocked this settle: T3 did not answer; retry, or settle in the T3 UI.");
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), homeWith(), { ...deps([]), threads: async () => { throw new Error("gone"); } }))).toContain("T3 did not answer");
    for (const settings of [undefined, { "guards.person": "  " }, { "guards.person": 3 }]) {
      expect(reasonOf(await guardSettle(organize({ action: "settle" }), homeWith(settings), deps([thread("mcp:me", { pullRequests: [pr(1)] })])))).toEndWith("the person who runs this machine can still settle the thread in T3.");
    }
    const broken = homeWith({});
    writeFileSync(join(broken, ".local/state/fleet/settings.json"), "{");
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), broken, deps([thread("mcp:me", { pullRequests: [pr(1)] })])))).toEndWith("the person who runs this machine can still settle the thread in T3.");
  });

  test("handover refuses anything but a GitHub PR URL and a thread id, and writes nothing", async () => {
    const home = homeWith();
    for (const args of [
      [], ["--pr", "https://github.com/acme/app/pull/1"], ["--pr", "https://github.com/acme/app/issues/1", "--to", "mcp:x"],
      ["--pr", "http://github.com/acme/app/pull/1", "--to", "mcp:x"], ["--pr", "https://github.com/acme/app/pull/1", "--to", "-x"],
      ["--to", "mcp:x", "--pr", "https://github.com/acme/app/pull/1", "extra"], ["--pr", "--to", "https://github.com/acme/app/pull/1", "mcp:x"],
      ["--pr", "https://github.com/acme/app/pull/1", "--to", "mcp x"], ["--pr", "https://github.com/acme/app/pull/1x", "--to", "mcp:x"], ["mcp:x", "--pr", "https://github.com/acme/app/pull/1", "mcp:y"],
    ]) await expect(prCommand(["handover", ...args], home)).rejects.toThrow("Usage: fleet pr handover --pr <PR URL> --to <thread id>");
    await expect(handover(home, undefined, "https://github.com/acme/app/pull/1", "mcp:x")).rejects.toThrow("fleet pr handover runs inside a T3 thread");
    expect(() => statSync(handoverPath(home))).toThrow();
  });

  test("lists each open top-level thread that owns an open PR for a box release", () => {
    expect(threadsOwningPrs([
      thread("mcp:a", { title: "Lane A", pullRequests: [pr(1), pr(2, "merged")] }),
      child("mcp:a1", "mcp:a", { pullRequests: [pr(3)] }),
      thread("mcp:b", { title: "Lane B" }),
      thread("mcp:c", { title: "Lane C", settledAt: "x", pullRequests: [pr(4)] }),
    ])).toEqual(["Lane A (owns open PR https://github.com/acme/app/pull/1, https://github.com/acme/app/pull/3)"]);
  });
});

describe("the installed settle guard", () => {
  const hookPath = join(import.meta.dir, "hooks", "settle-guard.ts");

  async function run(home: string, input: unknown, env: Record<string, string> = {}) {
    const bin = temp.make("fleet-gh-");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$*" in\n  "api repos/acme/app/pulls/1") echo '{"state":"open","merged_at":null}' ;;\n  "api repos/acme/app/pulls/2") echo '{"state":"closed","merged_at":"2026-11-01T00:00:00Z"}' ;;\n  *) echo "unexpected $*" >&2; exit 9 ;;\nesac\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const child = Bun.spawn([process.execPath, hookPath, "claude"], { stdin: new Blob([typeof input === "string" ? input : JSON.stringify(input)]), stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, T3CODE_THREAD_ID: "mcp:me", ...env } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout: stdout.trim(), stderr: stderr.trim(), code };
  }

  test("reads this machine's T3 and GitHub, refuses an open PR, and lets a merged one go", async () => {
    const stub = await startT3Stub({ shell: { projects: [], threads: [thread("mcp:me", { pullRequests: [pr(1)] }), thread("mcp:other", { pullRequests: [pr(2)] })] } });
    stubs.push(stub);
    const refused = await run(stub.home, organize({ action: "settle" }));
    expect(refused.code).toBe(0);
    expect(JSON.parse(refused.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("open PR(s) https://github.com/acme/app/pull/1, and") });
    expect((await run(stub.home, organize({ action: "settle", threadId: "mcp:other" })))).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  test("refuses a settle without T3, and stays quiet on input it cannot read", async () => {
    const home = homeWith();
    const refused = await run(home, organize({ action: "settle" }));
    expect(JSON.parse(refused.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("T3 did not answer") });
    expect(await run(home, "not json")).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  const linkedThread = (threadId: string, prs: number[], fields: Partial<LinkedThread> = {}): LinkedThread => ({
    threadId, projectId: "p", title: `Remote ${threadId}`, status: "idle", model: "m", parentThreadId: null, settled: false, snoozedUntil: null,
    pullRequests: prs.map((n) => ({ host: "github.com", ...pr(n) })), itemCount: 1, createdAt: "", updatedAt: "", ...fields,
  });

  async function machines(remote: LinkedThread[] | Error) {
    const stub = await startT3Stub({
      shell: { projects: [], threads: [thread("mcp:me", { pullRequests: [pr(1)] }), thread("mcp:other")] },
      environmentId: "env-here",
      links: [{ environmentId: "env-there", label: "box", urls: [], access: "full", linkedAt: "", expiresAt: "", lastReachedAt: null, lastError: null, status: "reachable" }],
      tools(name, args: any) {
        if (name !== "t3_thread_list" || args.environmentId !== "env-there") return undefined;
        if (remote instanceof Error) throw new ToolRefusal("environment_unreachable", remote.message);
        return { threads: remote, nextCursor: null };
      },
    });
    stubs.push(stub);
    return stub.home;
  }

  test("treats this machine's own environment id as this machine", async () => {
    const home = await machines([]);
    const refused = await run(home, organize({ action: "settle", environmentId: "env-here" }));
    expect(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecisionReason).toContain("open PR(s) https://github.com/acme/app/pull/1, and");
  });

  test("reads PR ownership on the linked machine a call names, and refuses when that machine does not answer", async () => {
    const home = await machines([linkedThread("mcp:far", [1]), linkedThread("mcp:shared", [2]), linkedThread("mcp:keeper", [2])]);
    const refused = await run(home, organize({ action: "settle", threadId: "mcp:far", environmentId: "env-there" }));
    expect(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecisionReason).toContain("open PR(s) https://github.com/acme/app/pull/1, and");
    expect(await run(home, organize({ action: "settle", threadId: "mcp:shared", environmentId: "env-there" }))).toEqual({ stdout: "", stderr: "", code: 0 });
    const down = await machines(new Error("the machine did not answer"));
    const unread = await run(down, organize({ action: "settle", threadId: "mcp:far", environmentId: "env-there" }));
    expect(JSON.parse(unread.stdout).hookSpecificOutput.permissionDecisionReason).toBe("Fleet blocked this settle: T3 did not answer; retry, or settle in the T3 UI.");
  });
});
