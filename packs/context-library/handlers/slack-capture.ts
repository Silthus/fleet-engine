import { homedir } from "node:os";
import { modelFor } from "../../base/lib/models.ts";
import { capture, captureAgent, type Agent } from "../lib/capture.ts";
import { librarySettings, writePointer } from "../lib/config.ts";
import { runGit, type Git } from "../lib/git.ts";

type Env = Record<string, string | undefined>;
export type SlackCaptureDeps = { env: Env; home: string; git: Git; agent: () => Agent; today: () => string };

export async function slackCapture(request: string, deps: SlackCaptureDeps): Promise<{ code: number; output: string }> {
  try {
    const { source, material } = JSON.parse(request) as { source?: unknown; material?: unknown };
    if (typeof source !== "string" || !/^https:\/\//.test(source) || (material !== undefined && typeof material !== "string")) throw new Error("the Slack capture needs an https source and the thread's text");
    const library = librarySettings(deps.env, deps.home);
    writePointer(deps.home, library);
    const saved = await capture({ source, via: "slack", material }, { home: deps.home, library, agent: deps.agent(), git: deps.git, today: deps.today });
    return { code: 0, output: JSON.stringify(saved) };
  } catch (error) {
    return { code: 1, output: JSON.stringify({ failed: (error as Error).message }) };
  }
}

if (import.meta.main) {
  const { code, output } = await slackCapture(await Bun.stdin.text(), {
    env: Bun.env, home: Bun.env.HOME ?? homedir(), git: runGit, agent: () => captureAgent(modelFor("survey")), today: () => new Date().toISOString().slice(0, 10),
  });
  console.log(output);
  process.exit(code);
}
