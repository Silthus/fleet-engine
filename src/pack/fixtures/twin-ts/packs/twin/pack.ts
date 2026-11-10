import type { Pack } from "../../../../../sdk/index.ts";

export default {
  sdk: 1,
  name: "twin",
  title: "Twin",
  summary: "The hub greets you once you pick a greeting.",
  risk: "None.",
  register(fleet) {
    const greeting = fleet.setting({ key: "twin.greeting", type: "string", question: "Which greeting?" });
    const hello = fleet.workflow({ id: "twin-hello", name: "Greet", sentence: "The hub greets you.", default: false, settings: [greeting] });
    const picked = fleet.check({
      on: "hub", when: hello, id: "twin-picked", say: "Pick a greeting.",
      test: async (ctx) => ctx.get(greeting) !== "",
      repair: { ask: "Run this command.", command: "fleet twin-hello setup", interactive: true },
    });
    fleet.command("twin-hello", { summary: "Pick a greeting", run: async () => 0 });
    fleet.service({ on: "hub", when: hello, after: picked, id: "twin-greeter", run: async () => {} });
    fleet.service({ os: "linux", plans: ["claude"], id: "twin-linux", run: async () => {} });
  },
} satisfies Pack;
