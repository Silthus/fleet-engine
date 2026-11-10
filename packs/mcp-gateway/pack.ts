import type { Context, Pack } from "../../src/sdk/index.ts";
import { gateway as host, gatewayKey } from "./lib/host.ts";

const connect = ["-c", 'exec sh "${FLEET_ENGINE_DIR:-$HOME/.local/share/fleet/engine}/fleet" mcp-connect'];
const usage = "usage: fleet mcp-gateway [doctor|sign-in|restart], or fleet mcp-gateway reconnect <server>";

export default {
  sdk: 1,
  name: "mcp-gateway",
  title: "MCP gateway",
  summary: "The hub signs in to your MCP servers once, and agents on every machine reach them through it.",
  day: "Every machine reaches your MCP servers through the hub, signed in once.",
  cost: "Docker on the hub. Every other machine reaches the gateway through its tunnel to the hub.",
  risk: "The hub holds the sign-ins for your MCP servers, and each machine holds a key that reaches all of them. Keep the hub as private as your laptop.",
  register(fleet) {
    const flow = fleet.workflow({
      id: "mcp-gateway",
      name: "MCP gateway",
      default: true,
      sentence: "The hub signs in to your MCP servers once, and agents on every machine reach them through it.",
      moment: {
        time: "09:20",
        title: "Every tool, signed in once",
        body: "An agent on your laptop reads a Slack thread and an agent on a fresh box queries your analytics, both through the hub. You signed in to each tool once.",
        words: ["hub", "agent", "MCP server"],
      },
    });
    const installed = fleet.check({
      on: "hub",
      os: "linux",
      when: flow,
      id: "mcp-gateway-installed",
      say: "The MCP gateway is not installed on the hub, or does not answer. Run fleet mcp-gateway doctor on the hub to see why.",
      test: async (ctx) => (await import("./lib/hub.ts")).doctor({ ...(await host(ctx)), print: () => {} }),
      repair: { ask: "Install the MCP gateway under Docker on the hub.", run: async (ctx) => (await import("./lib/install.ts")).install(await host(ctx)) },
    });
    const service = fleet.service({
      on: "hub",
      os: "linux",
      when: flow,
      id: "mcp-gateway",
      after: installed,
      serve: { port: 3317, health: "/health", credential: async (ctx, node) => (await import("./lib/hub.ts")).issueKey(node, await host(ctx)) },
    });
    fleet.check({
      when: flow,
      id: "mcp-gateway-client",
      say: "This machine cannot reach the MCP gateway. Run fleet run mcp-gateway/mcp-gateway-client to see why.",
      test: async (ctx) => {
        const { checkGateway } = await import("./lib/client.ts");
        const result = await checkGateway((await host(ctx)).home, await ctx.secrets.read(gatewayKey), (input, init) => fetch(input, init));
        return ctx.print(result.line), result.ok;
      },
      repair: {
        ask: "Write this machine's MCP gateway key to the client file that box handover reads.",
        run: async (ctx) => (await import("./lib/client.ts")).syncClientFile((await host(ctx)).home, await ctx.secrets.read(gatewayKey), (token) => ctx.secrets.write(gatewayKey, token)),
      },
    });
    fleet.config({ provider: "claude", plans: ["claude", "both"], when: flow, key: "mcpServers.fleet-hub", value: { type: "stdio", command: "sh", args: connect } });
    fleet.config({ provider: "codex", plans: ["codex", "both"], when: flow, key: "mcp_servers.fleet-hub", value: { command: "sh", args: connect } });
    fleet.command("mcp-connect", {
      summary: "Connect an agent to the MCP gateway over standard input and output",
      run: async (args, ctx) => {
        if (args.length) return console.error("usage: fleet mcp-connect"), 2;
        const { bridge } = await import("./lib/bridge.ts");
        let reach: { url: string; credential: string };
        try { reach = await ctx.use(service); }
        catch (error) { return console.error((error as Error).message), 1; }
        return bridge({ client: { baseUrl: `${reach.url}/mcphub`, token: reach.credential }, stdin: ctx.stdin(), write: ctx.print, fail: (line) => console.error(line), fetch: (input, init) => fetch(input, init) });
      },
    });
    fleet.command("mcp-gateway", {
      summary: "Check, sign in, reconnect, or restart the MCP gateway on the hub",
      run: async (args, ctx) => admin(args, ctx),
    });
  },
} satisfies Pack;

async function admin(args: string[], ctx: Context) {
  const [mode = "doctor", name, ...extra] = args;
  const plain = ["doctor", "sign-in", "restart"].includes(mode) && name === undefined;
  const named = mode === "reconnect" && name !== undefined && !extra.length;
  if (!plain && !named) return ctx.print(usage), 2;
  const hub = await host(ctx);
  const gateway = await import("./lib/hub.ts");
  if (mode === "doctor") return (await gateway.doctor(hub)) ? 0 : 1;
  if (mode === "sign-in") await gateway.signIn(hub);
  if (mode === "restart") await gateway.restart(hub);
  if (mode === "reconnect") await gateway.reconnect(name!, hub);
  return 0;
}
