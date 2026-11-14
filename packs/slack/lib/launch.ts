import { onHost } from "../../../src/hub/ssh.ts";
import { threadUrl, UnansweredLaunch } from "../../../src/integrations/t3/index.ts";
import type { Threads } from "../../../src/sdk/index.ts";
import type { DiskStatus } from "../../base/lib/disk.ts";
import type { Started } from "./trigger.ts";

export type Run = (argv: string[], input?: string, options?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
export type Claim = { box: string; environmentId?: string };
/** noRoom: the machine refused before it asked T3, because its disk is below the start floor. */
export type Failed = { failed: string; claim?: Claim; reachedT3?: true; noRoom?: true };
export type Timer = (fire: () => void, ms: number) => { cancel(): void };
export type LaunchRequest = { title: string; prompt: string; commandId: string; claim?: Claim; replay?: boolean };
export type Launch = ((request: LaunchRequest) => Promise<Started | Failed>) & { release?: (claim: Claim) => Promise<void> };

const realTimer: Timer = (fire, ms) => {
  const id = setTimeout(fire, ms);
  return { cancel: () => clearTimeout(id) };
};

export const timedOutCode = 124;

export function spawnRunner(timer: Timer = realTimer): Run {
  return async (argv, input, { timeoutMs } = {}) => {
    try {
      const child = Bun.spawn(argv, { env: process.env, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
      let timedOut = false;
      const limit = timeoutMs === undefined ? undefined : timer(() => ((timedOut = true), child.kill("SIGKILL")), timeoutMs);
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => limit?.cancel());
      return timedOut ? { code: timedOutCode, stdout, stderr: `${stderr}timed out after ${timeoutMs! / 1000} s\n` } : { code, stdout, stderr };
    } catch (error) {
      return { code: 127, stdout: "", stderr: (error as Error).message };
    }
  };
}

export const spawnRun = spawnRunner();

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";
const why = (result: { code: number; stderr: string; stdout: string }) => lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code}`;

export function launchHere(threads: Threads, room: () => DiskStatus): Launch {
  return async ({ title, prompt, commandId, replay }) => {
    const disk = replay ? undefined : room();
    if (disk?.critical) return { failed: disk.message.replaceAll("\n", " "), noRoom: true };
    try {
      const { id, url } = await threads.start({ key: commandId, title, prompt, modelRole: "implementation" });
      return { threadId: id, url, where: "this machine" };
    } catch (error) {
      return error instanceof UnansweredLaunch ? { failed: error.message, reachedT3: true } : { failed: (error as Error).message };
    }
  };
}

export function launchOnBox(fleet: string, run: Run): Launch {
  const launch: Launch = async ({ claim: held, ...request }) => {
    let claim = held;
    if (!claim) {
      const spawned = await run([fleet, "box", "spawn"]);
      if (spawned.code !== 0) return { failed: `fleet box spawn: ${why(spawned)}` };
      const [box, environmentId] = lastLine(spawned.stdout).split(/\s+/);
      if (!box) return { failed: "fleet box spawn printed no box" };
      claim = { box, environmentId };
    }
    const ran = await run([fleet, "box", "run", claim.box, "--", "fleet", "slack-trigger", "launch"], JSON.stringify(request));
    const answer = answerOf(lastLine(ran.stdout));
    if (ran.code === 0 && answer.threadId) return { threadId: answer.threadId, url: claim.environmentId ? threadUrl(claim.environmentId, answer.threadId) : undefined, where: claim.box };
    const failed = `fleet slack-trigger launch on ${claim.box}: ${answer.failed ?? why(ran)}`;
    return answer.reachedT3 ? { failed, claim, reachedT3: true } : { failed, claim };
  };
  launch.release = async (claim) => void (await run([fleet, "box", "release", claim.box]));
  return launch;
}

export const nodeLaunchLimitMs = 300_000;
const keepAlive = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"];
const notConnected = /^ssh: (connect to host \S+ port \d+: |Could not resolve hostname )/m;

/**
 * Starts each thread on the next node in turn; turn() hands out the turns and keeps them across restarts.
 * A failed launch moves on only when it never reached the node, or the node had no room to start, and no earlier try there may have reached T3.
 * Any other failure, such as a dropped connection or a timeout, keeps the launch on that node and replays it, so T3 starts one thread.
 * A claim from another mode, such as a box, does not hold here.
 */
export function launchOnNodes(nodes: string[], run: Run, turn: () => number): Launch {
  return async ({ claim, ...request }) => {
    const held = claim && nodes.includes(claim.box) ? claim.box : undefined;
    const node = held ?? nodes[turn() % nodes.length]!;
    const ran = await run(onHost(node, ["slack-trigger", "launch"], keepAlive), JSON.stringify(held ? request : { ...request, replay: undefined }), { timeoutMs: nodeLaunchLimitMs });
    const answer = answerOf(lastLine(ran.stdout));
    if (ran.code === 0 && answer.threadId) return { threadId: answer.threadId, url: answer.url, where: node };
    const failed = `fleet slack-trigger launch on ${node}: ${answer.failed ?? why(ran)}`;
    const replaying = held !== undefined && request.replay === true;
    if (!replaying && (answer.noRoom || (answer.failed === undefined && notConnected.test(ran.stderr)))) return { failed };
    return { failed, claim: { box: node }, ...(answer.reachedT3 || answer.failed === undefined ? { reachedT3: true as const } : {}) };
  };
}

function answerOf(line: string): { threadId?: string; url?: string; failed?: string; reachedT3?: true; noRoom?: true } {
  try {
    const value = JSON.parse(line) as { threadId?: unknown; url?: unknown; failed?: unknown; reachedT3?: unknown; noRoom?: unknown };
    return {
      ...(typeof value.threadId === "string" && value.threadId ? { threadId: value.threadId } : {}),
      ...(typeof value.url === "string" && value.url.startsWith("https://") ? { url: value.url } : {}),
      ...(typeof value.failed === "string" ? { failed: value.failed } : {}),
      ...(value.reachedT3 === true ? { reachedT3: true } : {}),
      ...(value.noRoom === true ? { noRoom: true } : {}),
    };
  } catch {
    return {};
  }
}
