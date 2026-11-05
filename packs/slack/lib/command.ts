import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modelFor } from "../../base/lib/models.ts";
import { optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import type { T3SessionOptions } from "../../base/lib/t3/index.ts";
import { launchHere, launchOnBox, spawnRun, type Launch, type LaunchRequest, type Run } from "./launch.ts";
import { manifest, manifestLink, readTokens, serve, slackApi, slackApiBase, type Sleep, type Tokens } from "./slack.ts";
import { Interrupted, secretReader, type ReadSecret } from "./secret.ts";
import { handleTrigger, retryPending, triggerOf, type Owner, type TriggerDeps } from "./trigger.ts";

type Env = Record<string, string | undefined>;

export type SlackCommandDeps = {
  env: Env;
  home: string;
  print: (line: string) => void;
  readStdin: () => Promise<string>;
  readSecret?: ReadSecret;
  run?: Run;
  slackBase?: string;
  sleep?: Sleep;
  now?: () => number;
  stop?: AbortSignal;
  t3?: T3SessionOptions;
  every?: (work: () => void, ms: number) => () => void;
};

export const usage = "Usage: fleet slack-trigger manifest | setup | run | check | launch";

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
  if (rest.length || !["manifest", "setup", "run", "check", "launch"].includes(mode)) return deps.print(usage), 2;
  const run = deps.run ?? spawnRun;
  if (mode === "launch") return launchFromStdin(deps);
  const owner = await ownerOf(deps.env, run);
  if (mode === "manifest") {
    deps.print(`Create the app: ${manifestLink(owner.name)}\n\n${JSON.stringify(manifest(owner.name), null, 2)}`);
    return 0;
  }
  if (mode === "check") return checkApp(owner, deps);
  if (mode === "setup") return setUpApp(owner, deps);
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
      if (message !== said) log(`waiting for the Slack app: ${message}. Run fleet slack-trigger setup to set it up.`);
      said = message;
    }
    await sleep(60_000);
  }
  return undefined;
}

async function setUpApp(owner: Owner, deps: SlackCommandDeps): Promise<number> {
  const read = deps.readSecret ?? secretReader();
  const path = tokensFile(deps.home);
  const base = deps.slackBase ?? slackApiBase;
  const say = deps.print;
  say(`Fleet starts a T3 thread when you, ${owner.slackUserId}, write to your own Slack app. Make that app in four steps.`);
  say("");
  say(`1. Open this link, pick your workspace, and create the app: ${manifestLink(owner.name)}`);
  say("2. Under Basic Information, App-Level Tokens, generate a token with the connections:write scope.");
  try {
    const appToken = await ask(read, "   Paste the app-level token (xapp-…, hidden): ", "xapp-", async (token) => void (await slackApi(token, base, deps.sleep)("apps.connections.open", {})), say);
    say("3. Under Install App, install the app to your workspace.");
    say("4. Copy the User OAuth Token from the same page.");
    const userToken = await ask(read, "   Paste the user token (xoxp-…, hidden): ", "xoxp-", async (token) => {
      const { user_id } = await slackApi(token, base, deps.sleep)("auth.test", {});
      if (user_id !== owner.slackUserId) throw new Error(`it belongs to ${user_id}, not to slack.userId ${owner.slackUserId}`);
    }, say);
    saveTokens(path, { appToken, userToken });
  } catch (error) {
    if (error instanceof Interrupted) return say(`Stopped. Nothing was saved. Run fleet slack-trigger setup again.`), 130;
    throw error;
  }
  say(`Saved ${path}, readable only by you. The Slack trigger picks the app up within a minute.`);
  return 0;
}

async function ask(read: ReadSecret, prompt: string, prefix: string, verify: (token: string) => Promise<void>, say: (line: string) => void): Promise<string> {
  for (;;) {
    const token = await read(prompt);
    if (!token.startsWith(prefix)) {
      say(`   That does not start with ${prefix}. Try again.`);
      continue;
    }
    try {
      await verify(token);
      return token;
    } catch (error) {
      say(`   Slack did not accept it: ${(error as Error).message.replace(token, "…")}. Try again.`);
    }
  }
}

function saveTokens(path: string, tokens: Tokens) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const draft = `${path}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  chmodSync(draft, 0o600);
  renameSync(draft, path);
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
