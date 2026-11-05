import { join } from "node:path";
import { modelFor } from "../../base/lib/models.ts";
import { optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import type { T3SessionOptions } from "../../base/lib/t3/index.ts";
import { launchHere, launchOnBox, spawnRun, type Launch, type LaunchRequest, type Run } from "./launch.ts";
import { manifest, manifestLink, readTokens, serve, slackApi, slackApiBase, type Sleep, type Tokens } from "./slack.ts";
import { handleTrigger, retryPending, triggerOf, type Owner, type TriggerDeps } from "./trigger.ts";

type Env = Record<string, string | undefined>;

export type SlackCommandDeps = {
  env: Env;
  home: string;
  print: (line: string) => void;
  readStdin: () => Promise<string>;
  run?: Run;
  slackBase?: string;
  sleep?: Sleep;
  now?: () => number;
  stop?: AbortSignal;
  t3?: T3SessionOptions;
  every?: (work: () => void, ms: number) => () => void;
};

export const usage = "Usage: fleet slack-trigger manifest | run | check | launch";

export const tokensFile = (home: string) => join(home, ".config/fleet/slack-app.json");
export const stateFile = (home: string) => join(home, ".local/state/fleet/slack-trigger.json");
const memberId = /^[UW][A-Z0-9]+$/;

export async function ownerOf(env: Env, run: Run): Promise<Owner> {
  const slackUserId = stringSetting("slack.userId", env);
  if (!memberId.test(slackUserId)) throw new Error(`slack.userId is ${JSON.stringify(slackUserId)}, not a Slack member ID such as U012ABCDEF. Set it with fleet set slack.userId=<your member ID>.`);
  const name = (await run(["git", "config", "--get", "user.name"])).stdout.trim();
  if (!name) throw new Error("Git has no user.name, which names your Slack app. Run fleet apply after gh auth login, so Fleet sets your Git identity.");
  return { name, slackUserId };
}

export function launcher(env: Env, run: Run, t3: T3SessionOptions = {}): Launch {
  if (optionalStringSetting("hub.boxTemplate", env) !== undefined) return launchOnBox(join(env.FLEET_ENGINE_DIR ?? "", "fleet"), run);
  return launchHere(modelFor("implementation", env), t3);
}

export async function slackTrigger(args: string[], deps: SlackCommandDeps): Promise<number> {
  const [mode = "", ...rest] = args;
  if (rest.length || !["manifest", "run", "check", "launch"].includes(mode)) return deps.print(usage), 2;
  const run = deps.run ?? spawnRun;
  if (mode === "launch") return launchFromStdin(deps);
  const owner = await ownerOf(deps.env, run);
  if (mode === "manifest") {
    deps.print(`Create the app: ${manifestLink(owner.name)}\n\n${JSON.stringify(manifest(owner.name), null, 2)}`);
    return 0;
  }
  if (mode === "check") return checkApp(owner, deps);
  const now = deps.now ?? Date.now;
  const log = (line: string) => deps.print(`${new Date(now()).toISOString()} ${line}`);
  const tokens = await waitForTokens(deps, log);
  if (!tokens) return 0;
  const trigger: TriggerDeps = { owner, now, log, slack: slackApi(tokens.userToken, deps.slackBase, deps.sleep), launch: launcher(deps.env, run, deps.t3), statePath: stateFile(deps.home) };
  const every = deps.every ?? ((work, ms) => { const timer = setInterval(work, ms); return () => clearInterval(timer); });
  const stopRetries = every(() => void retryPending(trigger).catch((error) => log(`retry failed: ${error}`)), 60_000);
  try {
    await serve({
      appToken: tokens.appToken, log, base: deps.slackBase, sleep: deps.sleep, stop: deps.stop,
      onEvent: (event) => {
        const found = triggerOf(event, owner);
        if (found) void handleTrigger(found, trigger).catch((error) => log(`${found.channel}:${found.ts}: failed: ${error}`));
      },
    });
  } finally {
    stopRetries();
  }
  return 0;
}

async function waitForTokens(deps: SlackCommandDeps, log: (line: string) => void): Promise<Tokens | undefined> {
  const sleep = deps.sleep ?? Bun.sleep;
  let said = "";
  while (!deps.stop?.aborted) {
    try {
      return readTokens(tokensFile(deps.home));
    } catch (error) {
      const message = (error as Error).message;
      if (message !== said) log(`waiting for the Slack app: ${message}. Run fleet slack-trigger manifest to set it up.`);
      said = message;
    }
    await sleep(60_000);
  }
  return undefined;
}

async function checkApp(owner: Owner, deps: SlackCommandDeps): Promise<number> {
  try {
    const tokens = readTokens(tokensFile(deps.home));
    const answer = await slackApi(tokens.userToken, deps.slackBase ?? slackApiBase, deps.sleep)("auth.test", {});
    if (answer.user_id !== owner.slackUserId) return deps.print(`The user token in ${tokensFile(deps.home)} belongs to ${answer.user_id}, not to slack.userId ${owner.slackUserId}.`), 1;
    deps.print(`The Slack app answers for ${owner.slackUserId}.`);
    return 0;
  } catch (error) {
    deps.print(`The Slack app is not set up: ${(error as Error).message}`);
    return 1;
  }
}

async function launchFromStdin(deps: SlackCommandDeps): Promise<number> {
  const request = JSON.parse(await deps.readStdin()) as Partial<LaunchRequest>;
  if (typeof request.title !== "string" || typeof request.prompt !== "string") throw new Error("fleet slack-trigger launch reads {\"title\", \"prompt\"} as JSON on standard input");
  const launched = await launchHere(modelFor("implementation", deps.env), deps.t3)(request.title, request.prompt);
  if ("failed" in launched) return deps.print(launched.failed), 1;
  deps.print(JSON.stringify({ threadId: launched.threadId, environmentId: launched.environmentId }));
  return 0;
}
