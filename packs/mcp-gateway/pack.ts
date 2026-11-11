import type { Context, Pack } from "../../src/sdk/index.ts";
import { gateway as host, gatewayKey } from "./lib/host.ts";

const connect = ["-c", 'exec sh "${FLEET_ENGINE_DIR:-$HOME/.local/share/fleet/engine}/fleet" mcp-connect'];
const usage = "usage: fleet mcp-gateway [doctor|sign-in|restart], fleet mcp-gateway reconnect <server>, or fleet mcp-gateway slack-bridge [sign-in]";
const bridge = () => import("./lib/slack-bridge.ts");

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
    const slack = fleet.workflow({
      id: "slack-bridge",
      name: "Slack bridge",
      default: false,
      sentence: "Agents read Slack as you through the MCP gateway, and leave only unsent drafts and canvases.",
      moment: {
        time: "11:40",
        title: "A reply waits for you, unsent",
        body: "An agent reads the incident thread and the canvas, fills the canvas in, and leaves a reply as a draft in the thread. You read it and press send.",
        words: ["agent"],
      },
      risk: "The bridge acts as your Slack account. It reads what you can read, and writes only drafts you send yourself and canvases.",
    });
    fleet.check({
      on: "hub",
      os: "linux",
      when: slack,
      id: "slack-bridge",
      say: "The MCP gateway has no Slack bridge, or not Fleet's. Run fleet mcp-gateway slack-bridge on the hub to see why.",
      test: async (ctx) => (await bridge()).slackBridgeRegistered(await host(ctx)).catch(() => false),
      repair: { ask: "Put the Slack bridge into the MCP gateway.", run: async (ctx) => (await bridge()).registerSlackBridge(await host(ctx)) },
    });
    fleet.check({
      on: "hub",
      os: "linux",
      when: slack,
      id: "slack-bridge-sign-in",
      say: "The Slack bridge has no ChatGPT sign-in. Sign in with the account whose Slack app it should use.",
      test: async (ctx) => (await bridge()).slackBridgeSignedIn(await host(ctx)),
      repair: { ask: "Sign the Slack bridge in to ChatGPT.", command: "fleet mcp-gateway slack-bridge sign-in", interactive: true },
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
      on: "hub",
      summary: "Check, sign in, reconnect, or restart the MCP gateway on the hub",
      run: async (args, ctx) => admin(args, ctx),
    });
  },
} satisfies Pack;

async function admin(args: string[], ctx: Context) {
  const [mode = "doctor", name, ...extra] = args;
  const plain = ["doctor", "sign-in", "restart", "slack-bridge"].includes(mode) && name === undefined;
  const named = mode === "reconnect" && name !== undefined && !extra.length;
  const bridgeSignIn = mode === "slack-bridge" && name === "sign-in" && !extra.length;
  if (!plain && !named && !bridgeSignIn) return ctx.print(usage), 2;
  const hub = await host(ctx);
  if (mode === "slack-bridge") return bridgeSignIn ? (await bridge()).signInSlackBridge(hub) : ((await (await bridge()).registerSlackBridge(hub)), 0);
  const gateway = await import("./lib/hub.ts");
  if (mode === "doctor") return (await gateway.doctor(hub)) ? 0 : 1;
  if (mode === "sign-in") await gateway.signIn(hub);
  if (mode === "restart") await gateway.restart(hub);
  if (mode === "reconnect") await gateway.reconnect(name!, hub);
  return 0;
}
