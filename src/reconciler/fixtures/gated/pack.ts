import type { Pack } from "../../../sdk/index.ts";

export default {
  sdk: 1,
  name: "gated",
  summary: "A service that waits for a saved token.",
  register(fleet) {
    fleet.command("gated", {
      summary: "Save the token",
      run: async ([mode], ctx) => {
        if (mode === "forget") return await ctx.secrets.write("token", ""), 0;
        if (mode === "break") return await ctx.secrets.write("broken", "yes"), 0;
        if (mode !== "setup") return 2;
        await ctx.secrets.write("token", "value");
        return (await ctx.secrets.read("broken")) === undefined ? 0 : 1;
      },
    });
    const saved = fleet.check({ id: "gated-saved", say: "The gated service needs its token.", test: async (ctx) => (await ctx.secrets.read("token")) === "value", repair: { ask: "Save the token.", command: "fleet gated setup" } });
    fleet.service({ id: "gated-worker", after: saved, run: async () => {} });
  },
} satisfies Pack;
