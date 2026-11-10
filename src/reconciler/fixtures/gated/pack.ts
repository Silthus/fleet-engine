import type { Pack } from "../../../sdk/index.ts";

export default {
  sdk: 1,
  name: "gated",
  summary: "A service that waits for a saved token.",
  register(fleet) {
    fleet.command("gated", {
      summary: "Save the token",
      run: async ([mode], ctx) => {
        if (mode !== "setup") return 2;
        await ctx.secrets.write("token", "value");
        return (await ctx.secrets.read("broken")) === undefined ? 0 : 1;
      },
    });
    const saved = fleet.check({ id: "gated-saved", say: "The gated service needs its token.", test: async (ctx) => (await ctx.secrets.read("token")) !== undefined, repair: { ask: "Save the token.", command: "fleet gated setup" } });
    fleet.service({ id: "gated-worker", after: saved, run: async () => {} });
  },
} satisfies Pack;
