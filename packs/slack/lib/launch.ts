import type { ModelRow } from "../../base/lib/models.ts";
import { launchScratchThread, withT3Session, type T3HttpClient, type T3SessionOptions } from "../../base/lib/t3/index.ts";
import type { Started } from "./trigger.ts";

export type Run = (argv: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export type Claim = { box: string; environmentId?: string };
export type Failed = { failed: string; claim?: Claim };
export type LaunchRequest = { title: string; prompt: string; commandId: string; claim?: Claim };
export type Launch = ((request: LaunchRequest) => Promise<Started | Failed>) & { release?: (claim: Claim) => Promise<void> };

export const launchScopes = ["orchestration:read", "orchestration:operate", "access:read"];

export const spawnRun: Run = async (argv, input) => {
  try {
    const child = Bun.spawn(argv, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: "", stderr: (error as Error).message };
  }
};

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";
const why = (result: { code: number; stderr: string; stdout: string }) => lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code}`;

export function launchHere(row: ModelRow, session: T3SessionOptions = {}): Launch {
  return async ({ title, prompt, commandId }) => {
    let started: Started | undefined;
    try {
      await withT3Session(async (client) => {
        started = { threadId: await launchScratchThread(client, { title, prompt, row, commandId }), where: "this machine" };
        started.environmentId = await environmentOf(client);
      }, { ...session, scopes: launchScopes });
    } catch (error) {
      if (!started) return { failed: (error as Error).message };
    }
    return started!;
  };
}

async function environmentOf(client: T3HttpClient): Promise<string | undefined> {
  const answer = await client.get<{ environmentId?: unknown }>("/.well-known/t3/environment").catch(() => undefined);
  return typeof answer?.environmentId === "string" ? answer.environmentId : undefined;
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
    const threadId = ran.code === 0 ? threadOf(lastLine(ran.stdout)) : undefined;
    if (threadId) return { threadId, environmentId: claim.environmentId, where: claim.box };
    return { failed: `fleet slack-trigger launch on ${claim.box}: ${why(ran)}`, claim };
  };
  launch.release = async (claim) => void (await run([fleet, "box", "release", claim.box]));
  return launch;
}

function threadOf(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as { threadId?: unknown };
    return typeof value.threadId === "string" && value.threadId ? value.threadId : undefined;
  } catch {
    return undefined;
  }
}
