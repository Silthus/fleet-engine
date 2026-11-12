import { homedir } from "node:os";
import type { Context, Pack, Setting } from "../../src/sdk/index.ts";

async function commandDeps(ctx: Context, userId: Setting<string>, emoji: Setting<string>, captureEmoji?: Setting<string>) {
  const { everyOn } = await import("./lib/command.ts");
  return {
    env: process.env, home: homedir(), slackUserId: () => ctx.get(userId), slackEmoji: () => ctx.get(emoji), ...(captureEmoji ? { slackCaptureEmoji: () => ctx.get(captureEmoji) } : {}), secrets: ctx.secrets, stateDir: ctx.stateDir, threads: ctx.threads,
    print: ctx.print, now: ctx.now, sleep: ctx.sleep, every: everyOn(ctx.sleep), readStdin: () => Bun.stdin.text(),
  };
}

export default {
  sdk: 1,
  name: "slack",
  title: "Slack",
  summary: "Your own message, reaction, or mention in Slack starts a T3 thread about it.",
  day: "A teammate reports a bug in a Slack thread. You react with your trigger emoji (default :t3code:), and a thread starts to find the cause, with the whole Slack thread as its context.",
  cost: "You need your own Slack app, which you make from a manifest in a few minutes. One small process stays connected to Slack.",
  risk: "Your Slack messages and the threads they belong to become agent prompts. Only your own messages, reactions, and mentions start a thread, and the prompt treats the rest of the Slack thread as data.",
  register(fleet) {
    const userId = fleet.setting({
      key: "slack.userId",
      type: "string",
      question: "What is your Slack member ID, so only your own messages start threads? In Slack, open your profile, then More, then Copy member ID.",
    });
    const emoji = fleet.setting({
      key: "slack.emoji",
      type: "string",
      default: "t3code",
      question: "Which Slack emoji starts a thread? Give its name, such as eye or +1.",
    });
    const captureEmoji = fleet.setting({
      key: "slack.captureEmoji",
      type: "string",
      default: "brain",
      ask: "never",
      question: "Which Slack emoji saves a message and its thread to your context library? Give its name, such as brain. It works while the Context library pack is on.",
    });
    const nodes = fleet.setting({
      key: "slack.nodes",
      type: "string",
      optional: true,
      ask: "never",
      question: "Which nodes start the threads that Slack asks for, as SSH names separated by spaces, such as devbox-1 devbox-2? Fleet takes them in turn. Leave it empty to start them on the hub, or on a box while Boxes is on.",
    });
    const threads = fleet.workflow({
      id: "slack-thread",
      name: "Start a thread from Slack",
      default: false,
      settings: [userId, emoji, captureEmoji, nodes],
      sentence: "Your own Slack message or reaction with your trigger emoji (default :t3code:), or a mention of your Slack app starts a T3 thread, and Slack shows you its link. With the Context library pack on, your :brain: reaction saves the thread to your notes.",
      risk: "Your Slack messages and the threads they belong to become agent prompts. Only your own messages, reactions, and mentions start a thread.",
    });
    const hub = { on: "hub", when: threads } as const;
    const app = fleet.check({
      ...hub,
      id: "slack-app",
      say: "Make your own Slack app for Start a thread from Slack, then paste its two tokens. Fleet keeps them where only you can read them.",
      test: async (ctx) => {
        const [{ appSecret }, { slackApp }] = await Promise.all([import("./lib/command.ts"), import("./lib/slack.ts")]);
        const saved = await ctx.secrets.read(appSecret);
        try {
          return slackApp(saved), true;
        } catch {
          return false;
        }
      },
      repair: { ask: "Run this command and follow its steps.", command: "fleet slack-trigger setup", interactive: true },
    });
    fleet.command("slack-trigger", {
      summary: "Set up or check your Slack app",
      run: async (args, ctx) => (await import("./lib/command.ts")).slackTrigger(args, await commandDeps(ctx, userId, emoji)),
    });
    fleet.service({
      ...hub,
      after: app,
      id: "slack-trigger",
      run: async (ctx) => (await import("./lib/command.ts")).listen(await commandDeps(ctx, userId, emoji, captureEmoji)),
    });
  },
} satisfies Pack;
