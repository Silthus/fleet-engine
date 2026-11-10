import type { Pack } from "../../../sdk/index.ts";

export default {
  sdk: 1,
  name: "served",
  summary: "A service on the hub that every node reaches at one port.",
  register(fleet) {
    const extra = fleet.workflow({ id: "served-extra", name: "Served extra", sentence: "The hub serves one more service.", default: false });
    fleet.command("served", {
      summary: "Install the served service",
      run: async ([mode], ctx) => (mode === "install" ? (await ctx.secrets.write("installed", "yes"), 0) : 2),
    });
    const installed = fleet.check({ on: "hub", id: "served-installed", say: "The served service is not installed.", test: async (ctx) => (await ctx.secrets.read("installed")) === "yes", repair: { ask: "Install it.", command: "fleet served install" } });
    fleet.service({ on: "hub", id: "served-api", after: installed, serve: { port: 4555, health: "/health", credential: async (_ctx, node) => `key-for-${node}` } });
    fleet.service({ on: "hub", id: "served-extra-api", when: extra, serve: { port: 4556, health: "/health", credential: async () => "extra" } });
    fleet.service({ on: "hub", id: "served-codex-api", os: "linux", plans: ["codex"], serve: { port: 4557, health: "/ready", credential: async () => "codex" } });
    fleet.config({ on: "hub", provider: "codex", key: "mcp_servers.served-admin", value: { command: "fleet", args: ["served", "admin"] }, after: installed });
    fleet.config({ provider: "codex", key: "mcp_servers.served", value: { command: "fleet", args: ["served", "connect"] } });
  },
} satisfies Pack;
