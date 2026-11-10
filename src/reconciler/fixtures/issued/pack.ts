import type { Pack } from "../../../sdk/index.ts";

export default {
  sdk: 1,
  name: "issued",
  summary: "A served service that issues a key for each node.",
  register(fleet) {
    const extra = fleet.workflow({ id: "issued-extra", name: "Issued extra", sentence: "The hub serves one more service.", default: false });
    const installed = fleet.check({
      on: "hub",
      id: "issued-installed",
      say: "The issued service is not installed.",
      test: async (ctx) => (await ctx.secrets.read("installed")) === "yes",
      repair: {
        run: async (ctx) => {
          if (await ctx.secrets.read("broken")) throw new Error("the install failed");
          await ctx.secrets.write("installed", "yes");
        },
      },
    });
    const api = fleet.service({
      on: "hub",
      id: "issued-api",
      after: installed,
      serve: {
        port: 4600,
        health: "/health",
        credential: async (ctx, node) => {
          if (await ctx.secrets.read("refuse")) throw new Error("the service said no");
          if (await ctx.secrets.read("leak")) {
            ctx.print("fleet: leaked-key");
            throw new Error("the issue of leaked-key failed");
          }
          ctx.print(`Issuing a key for ${node}`);
          const count = Number((await ctx.secrets.read("count")) ?? "0") + 1;
          await ctx.secrets.write("count", String(count));
          return `key-${count}-for-${node}`;
        },
      },
    });
    const spare = fleet.service({ on: "hub", id: "issued-spare", when: extra, serve: { port: 4601, health: "/health", credential: async () => "spare" } });
    fleet.command("issued-admin", {
      on: "hub",
      summary: "Show what the hub holds",
      run: async (args, ctx) => (ctx.print(`${(await ctx.secrets.read("installed")) ?? "not installed"} ${JSON.stringify(args)}`), args.includes("fail") ? 3 : 0),
    });
    fleet.command("issued", {
      summary: "Use the issued service",
      run: async ([mode], ctx) => {
        if (mode === "use" || mode === "spare") {
          const { url, credential } = await ctx.use(mode === "use" ? api : spare);
          return ctx.print(`${url} ${credential}`), 0;
        }
        if (mode === "break") return await ctx.secrets.write("broken", "yes"), 0;
        if (mode === "refuse" || mode === "leak") return await ctx.secrets.write(mode, "yes"), 0;
        return 2;
      },
    });
  },
} satisfies Pack;
