import type { Pack } from "../../../sdk/index.ts";

export default {
  sdk: 1,
  name: "kit",
  summary: "A pack that drives every part of the context.",
  register(fleet) {
    const greeting = fleet.setting({ key: "kit.greeting", type: "string", question: "Which greeting?", default: "hello" });
    fleet.command("kit", {
      summary: "Use the context",
      run: async ([mode, ...rest], ctx) => {
        if (mode === "greet") return ctx.print(`${ctx.get(greeting)} ${rest.join(" ")}`), 0;
        if (mode === "stray") return ctx.print(String(ctx.get({} as typeof greeting))), 0;
        if (mode === "save") return await ctx.secrets.write(rest[0]!, rest[1]!), 0;
        if (mode === "show") return ctx.print((await ctx.secrets.read(rest[0]!)) ?? "no secret"), 0;
        if (mode === "fail") throw new Error("kit failed");
        if (mode === "env") return ctx.print(`${process.env.HOME} ${process.env.FLEET_ENGINE_DIR} ${process.env.FLEET_SETTINGS}`), 0;
        if (mode === "start") {
          const thread = await ctx.threads.start({ key: rest[0]!, title: "Kit", prompt: "Say hello.", modelRole: "implementation" });
          return ctx.print(thread.url ?? thread.id), 0;
        }
        return 2;
      },
    });
    fleet.service({
      id: "kit-ticker",
      run: async (ctx) => {
        for (let tick = 1; tick <= 3; tick++) {
          ctx.log(`tick ${tick}`);
          await ctx.sleep(60_000);
        }
        await Bun.write(`${ctx.stateDir}/ticked`, String(ctx.now()));
      },
    });
    const extra = fleet.workflow({ id: "kit-extra", name: "Kit extra", sentence: "The kit runs one more service.", default: false });
    fleet.service({ id: "kit-extra-run", when: extra, run: async (ctx) => ctx.print("ran") });
    fleet.check({ id: "kit-saved", say: "Save the token.", test: async (ctx) => (await ctx.secrets.read("token")) !== undefined });
  },
} satisfies Pack;
