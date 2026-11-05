import type { ModelRow } from "../../base/lib/models.ts";
import { launchScratchThread, launchScopes, withT3Session, type T3SessionOptions } from "../../base/lib/t3/index.ts";
import type { Started } from "./trigger.ts";

export type Run = (argv: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export type Launch = (title: string, prompt: string) => Promise<Started | { failed: string }>;
export type LaunchRequest = { title: string; prompt: string };

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

export function launchHere(model: ModelRow, session: T3SessionOptions = {}): Launch {
  return async (title, prompt) => {
    try {
      const launched = await withT3Session((client) => launchScratchThread(client, { title, prompt, model }), { ...session, scopes: launchScopes });
      return { ...launched, where: "this machine" };
    } catch (error) {
      return { failed: (error as Error).message };
    }
  };
}

export function launchOnBox(fleet: string, run: Run): Launch {
  return async (title, prompt) => {
    const spawned = await run([fleet, "box", "spawn"]);
    if (spawned.code !== 0) return { failed: `fleet box spawn: ${why(spawned)}` };
    const [box, environmentId] = lastLine(spawned.stdout).split(/\s+/);
    if (!box) return { failed: "fleet box spawn printed no box" };
    const request: LaunchRequest = { title, prompt };
    const ran = await run([fleet, "box", "run", box, "--", "fleet", "slack-trigger", "launch"], JSON.stringify(request));
    const threadId = ran.code === 0 ? threadOf(lastLine(ran.stdout)) : undefined;
    if (threadId) return { threadId, environmentId, where: box };
    await run([fleet, "box", "release", box]);
    return { failed: `fleet slack-trigger launch on ${box}: ${why(ran)}` };
  };
}

function threadOf(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as { threadId?: unknown };
    return typeof value.threadId === "string" && value.threadId ? value.threadId : undefined;
  } catch {
    return undefined;
  }
}
