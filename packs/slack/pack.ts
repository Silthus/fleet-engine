import type { Context, Pack, Setting } from "../../src/sdk/index.ts";

async function commandDeps(ctx: Context, userId: Setting<string>) {
  const { everyOn } = await import("./lib/command.ts");
  return {
    env: process.env, slackUserId: () => ctx.get(userId), secrets: ctx.secrets, stateDir: ctx.stateDir, threads: ctx.threads,
    print: ctx.print, now: ctx.now, sleep: ctx.sleep, every: everyOn(ctx.sleep), readStdin: () => Bun.stdin.text(),
  };
}

export default {
  sdk: 1,
  name: "slack",
  title: "Slack",
  summary: "Your own message, reaction, or mention in Slack starts a T3 thread about it.",
  day: "A teammate reports a bug in a Slack thread. You react with :t3code:, and a thread starts to find the cause, with the whole Slack thread as its context.",
  cost: "Your own Slack app, made from a manifest in a few minutes, and one small process that stays connected to Slack.",
  risk: "Your Slack messages and the threads they belong to become agent prompts. Only your own messages, reactions, and mentions start a thread, and the prompt treats the rest of the Slack thread as data.",
  register(fleet) {
    const userId = fleet.setting({
      key: "slack.userId",
      type: "string",
      question: "What is your Slack member ID, so only your own messages start threads? In Slack, open your profile, then More, then Copy member ID.",
    });
    const threads = fleet.workflow({
      id: "slack-thread",
      name: "Start a thread from Slack",
      default: false,
      settings: [userId],
      sentence: "Your own Slack message with :t3code:, your :t3code: reaction, or a mention of your Slack app starts a T3 thread, and Slack shows you its link.",
      moment: {
        time: "13:50",
        title: "A thread from a Slack emoji",
        body: "A teammate reports a bug in Slack. You react with one emoji, and a thread starts to find the cause. Slack shows you its link a few seconds later.",
        words: ["thread"],
      },
      risk: "Your Slack messages and the threads they belong to become agent prompts. Only your own messages, reactions, and mentions start a thread.",
    });
    const hub = { on: "hub", when: threads } as const;
    const app = fleet.check({
      ...hub,
      id: "slack-app",
      say: "Make your own Slack app for Start a thread from Slack, then paste its two tokens. Fleet keeps them where only you can read them.",
      test: async (ctx) => (await ctx.secrets.read("app")) !== undefined,
      repair: { ask: "Run this command and follow its steps.", command: "fleet slack-trigger setup", interactive: true },
    });
    fleet.command("slack-trigger", {
      summary: "Set up or check your Slack app",
      run: async (args, ctx) => (await import("./lib/command.ts")).slackTrigger(args, await commandDeps(ctx, userId)),
    });
    fleet.service({
      ...hub,
      after: app,
      id: "slack-trigger",
      run: async (ctx) => (await import("./lib/command.ts")).listen(await commandDeps(ctx, userId)),
    });
  },
} satisfies Pack;
