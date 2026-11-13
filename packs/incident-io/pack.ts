import type { Pack } from "../../src/sdk/index.ts";

export default {
  sdk: 1,
  name: "incident-io",
  title: "incident.io",
  summary: "An agent that watches a risky change pages you, and only you, through incident.io when it goes wrong.",
  day: "You roll out a risky production change and go to dinner. The agent that watches it sees the error rate cross the tripwire you named, and your phone rings through Do Not Disturb with the title and the undo step. Nobody on the on-call rotation is paged, and no incident is declared.",
  cost: "You need an incident.io On-call seat, and the rights to create one HTTP alert source and one alert route, or an admin who makes them for you.",
  risk: "Anyone with the alert source token can page you, and each page shows in your organization's alert list. The alert route alone decides who is paged, so a changed route pages whoever it names.",
  instructions: "instructions.md",
  register(fleet) {
    const paging = fleet.workflow({
      id: "page-owner",
      name: "Page you through incident.io",
      default: false,
      sentence: "An agent that watches a change you name pages you, and only you, through your own incident.io alert source when its tripwire fires, without paging the on-call rotation or declaring an incident.",
      risk: "Anyone with the alert source token can page you, and each page shows in your organization's alert list.",
    });
    fleet.check({
      on: "hub",
      when: paging,
      id: "incident-io-source",
      say: 'Save your incident.io alert source for the page-owner workflow. When one is saved and this stays, fleet page --key setup-check --title "Setup check" --dry-run says what is wrong with it.',
      test: async (ctx) => (await import("./lib/page.ts")).sourceSaved(ctx),
      repair: { ask: "Follow packs/incident-io/SETUP.md, which ends with: fleet page setup <alert source URL> < <token file>" },
    });
    fleet.command("page", {
      summary: "Page yourself through incident.io, or withdraw the page",
      subcommands: ["setup"],
      on: "hub",
      when: paging,
      run: async (args, ctx) => (await import("./lib/page.ts")).page(args, ctx),
    });
  },
} satisfies Pack;
