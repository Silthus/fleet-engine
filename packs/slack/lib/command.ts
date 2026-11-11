import { join } from "node:path";
import { freeBytes, startRoom } from "../../base/lib/disk.ts";
import { optionalStringSetting } from "../../base/lib/settings.ts";
import type { Secrets, Threads } from "../../../src/sdk/index.ts";
import { launchHere, launchOnBox, spawnRun, type Launch, type LaunchRequest, type Run } from "./launch.ts";
import { manifest, manifestLink, serve, slackApi, slackApiBase, slackApp, type Sleep } from "./slack.ts";
import { Interrupted, secretReader, type ReadSecret } from "./secret.ts";
import { handleTrigger, retryPending, triggerOf, type Owner, type TriggerDeps } from "./trigger.ts";

type Env = Record<string, string | undefined>;
export type Every = (work: () => void, ms: number) => () => void;

export type SlackCommandDeps = {
  env: Env;
  home: string;
  freeBytes?: (path: string) => number;
  slackUserId: () => string;
  secrets: Secrets;
  stateDir: string;
  threads: Threads;
  print: (line: string) => void;
  readStdin: () => Promise<string>;
  every: Every;
  readSecret?: ReadSecret;
  run?: Run;
  slackBase?: string;
  sleep?: Sleep;
  now?: () => number;
  stop?: AbortSignal;
};

export const usage = "Usage: fleet slack-trigger manifest | setup | check | launch";

export const appSecret = "app";
const memberId = /^[UW][A-Z0-9]+$/;

export function everyOn(sleep: Sleep): Every {
  return (work, ms) => {
    let on = true;
    void (async () => {
      while (on) {
        await sleep(ms);
        if (on) work();
      }
    })();
    return () => void (on = false);
  };
}

export async function ownerOf(deps: Pick<SlackCommandDeps, "slackUserId">, run: Run): Promise<Owner> {
  const slackUserId = deps.slackUserId();
  if (!memberId.test(slackUserId)) throw new Error(`slack.userId is ${JSON.stringify(slackUserId)}, not a Slack member ID such as U012ABCDEF. Set it with fleet set slack.userId=<your member ID>.`);
  const name = (await run(["git", "config", "--get", "user.name"])).stdout.trim();
  if (!name) throw new Error("Git has no user.name, which names your Slack app. Run fleet apply after gh auth login, so Fleet sets your Git identity.");
  return { name, slackUserId };
}

const roomHere = (deps: SlackCommandDeps) => startRoom(deps.home, deps.env, deps.freeBytes ?? freeBytes);

export function launcher(deps: SlackCommandDeps, run: Run): Launch {
  if (optionalStringSetting("hub.boxTemplate", deps.env) !== undefined) return launchOnBox(join(deps.env.FLEET_ENGINE_DIR ?? "", "fleet"), run);
  return launchHere(deps.threads, roomHere(deps));
}

export async function slackTrigger(args: string[], deps: SlackCommandDeps): Promise<number> {
  const [mode = "", ...rest] = args;
  if (rest.length || !["manifest", "setup", "check", "launch"].includes(mode)) return deps.print(usage), 2;
  const run = deps.run ?? spawnRun;
  if (mode === "launch") return launchFromStdin(deps);
  const owner = await ownerOf(deps, run);
  if (mode === "manifest") {
    deps.print(`Create the app: ${manifestLink(owner.name)}\n\n${JSON.stringify(manifest(owner.name), null, 2)}`);
    return 0;
  }
  if (mode === "check") return checkApp(owner, deps);
  return setUpApp(owner, deps);
}

export async function listen(deps: SlackCommandDeps): Promise<void> {
  const run = deps.run ?? spawnRun;
  const owner = await ownerOf(deps, run);
  const now = deps.now ?? Date.now;
  const log = (line: string) => deps.print(`${new Date(now()).toISOString()} ${line}`);
  const saved = await deps.secrets.read(appSecret);
  const { appToken, userToken } = slackApp(saved);
  const replaced = new AbortController();
  const stop = deps.stop ? AbortSignal.any([deps.stop, replaced.signal]) : replaced.signal;
  const trigger: TriggerDeps = { owner, now, log, slack: slackApi(userToken, deps.slackBase, deps.sleep), launch: launcher(deps, run), statePath: join(deps.stateDir, "slack-trigger.json") };
  const active = new Set<Promise<void>>();
  const track = (work: Promise<void>, failed: (error: unknown) => void) => {
    const tracked = work.catch(failed).finally(() => active.delete(tracked));
    active.add(tracked);
  };
  const minute = async () => {
    if (stop.aborted) return;
    if ((await deps.secrets.read(appSecret)) !== saved) {
      log("the Slack app changed: stopping, so the service starts again with it");
      return replaced.abort();
    }
    await retryPending(trigger);
  };
  const stopMinutes = deps.every(() => track(minute(), (error) => log(`retry failed: ${error}`)), 60_000);
  try {
    await serve({
      appToken, log, base: deps.slackBase, sleep: deps.sleep, stop,
      onEvent: (event) => {
        const found = triggerOf(event, owner);
        if (found) track(handleTrigger(found, trigger), (error) => log(`${found.channel}:${found.ts}: failed: ${error}`));
      },
    });
  } finally {
    stopMinutes();
    while (active.size) await Promise.all(active);
  }
}

async function setUpApp(owner: Owner, deps: SlackCommandDeps): Promise<number> {
  const reader = deps.readSecret ? { read: deps.readSecret, close: () => {} } : secretReader();
  try {
    return await walkThrough(owner, deps, reader.read);
  } finally {
    reader.close();
  }
}

async function walkThrough(owner: Owner, deps: SlackCommandDeps, read: ReadSecret): Promise<number> {
  const base = deps.slackBase ?? slackApiBase;
  const say = deps.print;
  const entered: string[] = [];
  say(`Fleet starts a T3 thread when you, ${owner.slackUserId}, write to your own Slack app. Make that app in four steps.`);
  say("");
  say(`1. Open this link, pick your workspace, and create the app: ${manifestLink(owner.name)}`);
  say("2. Under Basic Information, App-Level Tokens, generate a token with the connections:write scope.");
  try {
    const appToken = await ask(read, "   Paste the app-level token (xapp-…, hidden): ", "xapp-", async (token) => void (await slackApi(token, base, deps.sleep)("apps.connections.open", {})), say, entered);
    say("3. Under Install App, install the app to your workspace.");
    say("4. Copy the User OAuth Token from the same page.");
    const userToken = await ask(read, "   Paste the user token (xoxp-…, hidden): ", "xoxp-", async (token) => {
      const { user_id } = await slackApi(token, base, deps.sleep)("auth.test", {});
      if (user_id !== owner.slackUserId) throw new Error(`it belongs to ${user_id}, not to slack.userId ${owner.slackUserId}`);
    }, say, entered);
    await deps.secrets.write(appSecret, `${JSON.stringify({ appToken, userToken }, null, 2)}\n`);
  } catch (error) {
    if (error instanceof Interrupted) return say(`Stopped. Nothing was saved. Run fleet slack-trigger setup again.`), 130;
    throw error;
  }
  say("Saved both tokens where only you can read them. A running Slack trigger starts again with them within a minute.");
  return 0;
}

async function ask(read: ReadSecret, prompt: string, prefix: string, verify: (token: string) => Promise<void>, say: (line: string) => void, entered: string[]): Promise<string> {
  const redact = (text: string) => {
    const secrets = [...entered].sort((a, b) => b.length - a.length).map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return secrets.length ? text.replace(new RegExp(secrets.join("|"), "g"), "…") : text;
  };
  for (;;) {
    const token = await read(prompt);
    if (token) entered.push(token);
    if (!token.startsWith(prefix)) {
      say(`   That does not start with ${prefix}. Try again.`);
      continue;
    }
    try {
      await verify(token);
      return token;
    } catch (error) {
      say(`   Slack did not accept it: ${redact((error as Error).message)}. Try again.`);
    }
  }
}

async function checkApp(owner: Owner, deps: SlackCommandDeps): Promise<number> {
  try {
    const { userToken } = slackApp(await deps.secrets.read(appSecret));
    const answer = await slackApi(userToken, deps.slackBase ?? slackApiBase, deps.sleep)("auth.test", {});
    if (answer.user_id !== owner.slackUserId) return deps.print(`The saved user token belongs to ${answer.user_id}, not to slack.userId ${owner.slackUserId}.`), 1;
    deps.print(`The Slack app answers for ${owner.slackUserId}.`);
    return 0;
  } catch (error) {
    deps.print(`The Slack app is not set up: ${(error as Error).message}`);
    return 1;
  }
}

async function launchFromStdin(deps: SlackCommandDeps): Promise<number> {
  const request = JSON.parse(await deps.readStdin()) as Partial<LaunchRequest>;
  if (typeof request.title !== "string" || typeof request.prompt !== "string" || typeof request.commandId !== "string") throw new Error("fleet slack-trigger launch reads {\"title\", \"prompt\", \"commandId\"} as JSON on standard input");
  const launched = await launchHere(deps.threads, roomHere(deps))({ title: request.title, prompt: request.prompt, commandId: request.commandId, replay: request.replay === true });
  if ("failed" in launched) return deps.print(JSON.stringify({ failed: launched.failed, ...(launched.reachedT3 ? { reachedT3: true } : {}) })), 1;
  deps.print(JSON.stringify({ threadId: launched.threadId }));
  return 0;
}
