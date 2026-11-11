import { join } from "node:path";
import type { Context, Pack } from "../../src/sdk/index.ts";
import { googleApps } from "./lib/apps.ts";
import { defaultQuery } from "./lib/mail-watch.ts";
import { gateway as host, gatewayKey } from "./lib/host.ts";

const connect = ["-c", 'exec sh "${FLEET_ENGINE_DIR:-$HOME/.local/share/fleet/engine}/fleet" mcp-connect'];
const usage = "usage: fleet mcp-gateway [doctor|sign-in|restart], fleet mcp-gateway sign-in <app>, fleet mcp-gateway reconnect <server>, or fleet mcp-gateway slack-bridge [sign-in]";
const upstreams = () => import("./lib/upstreams.ts");
const slackApp = async () => (await import("./lib/apps.ts")).slack;

export default {
  sdk: 1,
  name: "mcp-gateway",
  title: "MCP gateway",
  summary: "The hub signs in to your MCP servers once, and agents on every machine reach them through it.",
  day: "Every machine reaches your MCP servers through the hub, signed in once.",
  cost: "The hub needs Docker. Every other machine reaches the gateway through its tunnel to the hub.",
  risk: "The hub holds the sign-ins for your MCP servers, and each machine holds a key that reaches all of them. Keep the hub as private as your laptop.",
  register(fleet) {
    const flow = fleet.workflow({
      id: "mcp-gateway",
      name: "MCP gateway",
      default: true,
      sentence: "The hub signs in to your MCP servers once, and agents on every machine reach them through it.",
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
      on: "hub",
      os: "linux",
      when: flow,
      id: "mcp-gateway-upstreams",
      say: "The MCP gateway lacks an upstream that a pack declares, or serves it with other settings. Run fleet mcp-gateway doctor on the hub to see why.",
      test: async (ctx) => (await upstreams()).upstreamsRegistered(await host(ctx)).catch(() => false),
      repair: { ask: "Put the upstreams that your packs declare into the MCP gateway.", run: async (ctx) => (await upstreams()).registerUpstreams(await host(ctx)) },
    });
    const slack = fleet.workflow({
      id: "slack-bridge",
      name: "Slack bridge",
      default: false,
      sentence: "Agents read Slack as you through the MCP gateway, and leave only unsent drafts and canvases.",
      risk: "The bridge acts as your Slack account. It reads what you can read, and writes only drafts you send yourself and canvases.",
    });
    fleet.check({
      on: "hub",
      os: "linux",
      when: slack,
      id: "slack-bridge",
      say: "The MCP gateway has no Slack bridge, or not Fleet's. Run fleet mcp-gateway slack-bridge on the hub to see why.",
      test: async (ctx) => (await upstreams()).upstreamRegistered(await host(ctx), await slackApp()).catch(() => false),
      repair: { ask: "Put the Slack bridge into the MCP gateway.", run: async (ctx) => (await upstreams()).registerUpstream(await host(ctx), await slackApp()) },
    });
    fleet.check({
      on: "hub",
      os: "linux",
      when: slack,
      id: "slack-bridge-sign-in",
      say: "The Slack bridge has no ChatGPT sign-in. Sign in with the account whose Slack app it should use.",
      test: async (ctx) => (await upstreams()).appSignedIn(await host(ctx), await slackApp()),
      repair: { ask: "Sign the Slack bridge in to ChatGPT.", command: "fleet mcp-gateway slack-bridge sign-in", interactive: true },
    });
    const sentences = {
      gmail: "Agents read your mail and leave replies as unsent drafts, through the MCP gateway.",
      "google-calendar": "Agents read your calendar through the MCP gateway, and change nothing.",
      "google-drive": "Agents read your documents, sheets and slides through the MCP gateway, and change nothing.",
    };
    for (const app of googleApps) {
      const workflow = fleet.workflow({
        id: app.name,
        name: app.title,
        default: false,
        requires: ["mcp-gateway"],
        sentence: sentences[app.name as keyof typeof sentences],
        risk: `The route acts as your Google account through a ChatGPT sign-in. Only its allowlist keeps agents from tools that send, change or delete, so native Codex turns ${app.title} off on every machine.`,
      });
      fleet.check({
        on: "hub",
        os: "linux",
        when: workflow,
        id: app.name,
        say: `The MCP gateway does not serve ${app.title}, or not Fleet's route. Run fleet mcp-gateway doctor on the hub to see why.`,
        test: async (ctx) => (await upstreams()).upstreamRegistered(await host(ctx), app).catch(() => false),
        repair: { ask: `Put the ${app.title} route into the MCP gateway.`, run: async (ctx) => (await upstreams()).registerUpstream(await host(ctx), app) },
      });
      fleet.check({
        on: "hub",
        os: "linux",
        when: workflow,
        id: `${app.name}-sign-in`,
        say: `${app.title} has no ChatGPT sign-in. Sign in with the account whose workspace has ${app.title} connected.`,
        test: async (ctx) => (await upstreams()).appSignedIn(await host(ctx), app),
        repair: { ask: `Sign ${app.title} in to ChatGPT.`, command: `fleet mcp-gateway sign-in ${app.name}`, interactive: true },
      });
      fleet.config({ provider: "codex", plans: ["codex", "both"], when: workflow, key: `apps.${app.app}.enabled`, value: false });
    }
    const query = fleet.setting({
      key: "mcp-gateway.mailQuery",
      type: "string",
      default: defaultQuery,
      question: "Which Gmail search finds the mail that may be a reply to you? Mail watch adds the time window itself.",
    });
    const mail = fleet.workflow({
      id: "mail-watch",
      name: "Mail replies start threads",
      default: false,
      requires: ["gmail"],
      settings: [query],
      sentence: "A reply in a Gmail conversation that you wrote in starts a T3 thread about it, and later replies in that conversation go to the same thread.",
      risk: "Mail from outside becomes agent prompts. The prompt treats every email as data, and the Gmail route can only read mail and write drafts.",
    });
    const watchOf = async (ctx: Context) => ({
      gateway: await ctx.use(service), threads: ctx.threads, statePath: join(ctx.stateDir, "mail-watch.json"), query: ctx.get(query), now: ctx.now, log: ctx.log, fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
    });
    fleet.service({
      on: "hub",
      os: "linux",
      when: mail,
      id: "mail-watch",
      run: async (ctx) => (await import("./lib/mail-watch.ts")).watchMail(await watchOf(ctx), ctx.sleep),
    });
    fleet.command("mail-watch", {
      on: "hub",
      summary: "Say which Gmail replies the next mail watch check would start or follow up, and change nothing",
      run: async (args, ctx) => {
        if (args.length) return ctx.print("usage: fleet mail-watch"), 2;
        return (await import("./lib/mail-watch.ts")).checkMail({ ...(await watchOf(ctx)), log: ctx.print }, true).then((ok) => (ok ? 0 : 1));
      },
    });
    const reviewSearch = fleet.setting({
      key: "mcp-gateway.reviewWaitSearch",
      type: "string",
      default: "",
      question: "Which GitHub search qualifiers narrow the ready pull requests that review wait watches, such as org:your-org? Leave it empty for all of yours.",
    });
    const reviewAsks = fleet.setting({
      key: "mcp-gateway.reviewWaitAsks",
      type: "string",
      question: "Which Slack search filter finds your own review asks, such as from:<@U012ABCDEF> in:#your-team? Review wait holds a pull request you linked there in the last 12 hours.",
    });
    const reviews = fleet.workflow({
      id: "review-wait",
      name: "Review wait wakes threads",
      default: false,
      requires: ["slack-bridge"],
      settings: [reviewSearch, reviewAsks],
      sentence: "When a ready pull request of yours waits 4 hours on a review nobody gave, the T3 thread that links it wakes up, and again at 24 hours.",
      risk: "Reads your pull requests on GitHub and your own Slack messages from the last 12 hours. It messages your threads and changes nothing on GitHub or Slack.",
    });
    const reviewWaitOf = async (ctx: Context) => {
      const [{ runGh }, { hostname }] = await Promise.all([import("../pull-requests/lib/gh.ts"), import("node:os")]);
      return {
        gh: runGh, qualifiers: ctx.get(reviewSearch), threads: ctx.threads, session: {}, host: hostname(),
        slack: { gateway: await ctx.use(service), filter: ctx.get(reviewAsks), fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init) },
        statePath: join(ctx.stateDir, "review-wait.json"), now: ctx.now, log: ctx.log,
      };
    };
    fleet.service({
      on: "hub",
      os: "linux",
      when: reviews,
      id: "review-wait",
      run: async (ctx) => (await import("./lib/review-wait.ts")).watchReviews(await reviewWaitOf(ctx), ctx.sleep),
    });
    fleet.command("review-wait", {
      on: "hub",
      summary: "Say which threads the next review wait check would wake for pull requests that wait on a review, and change nothing",
      run: async (args, ctx) => {
        if (args.length) return ctx.print("usage: fleet review-wait"), 2;
        return (await import("./lib/review-wait.ts")).checkReviews({ ...(await reviewWaitOf(ctx)), log: ctx.print }, true).then((ok) => (ok ? 0 : 1));
      },
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
  const named = ["reconnect", "sign-in"].includes(mode) && name !== undefined && !extra.length;
  const bridgeSignIn = mode === "slack-bridge" && name === "sign-in" && !extra.length;
  if (!plain && !named && !bridgeSignIn) return ctx.print(usage), 2;
  const hub = await host(ctx);
  const apps = await upstreams();
  if (mode === "slack-bridge") return bridgeSignIn ? apps.signInApp(hub, await slackApp()) : ((await apps.registerUpstream(hub, await slackApp())), 0);
  if (mode === "sign-in" && name !== undefined) {
    const app = (await apps.codexApps(hub.home)).find((item) => item.name === name);
    if (!app) return ctx.print(`Name an app that signs in through ChatGPT: ${(await apps.codexApps(hub.home)).map((item) => item.name).join(", ")}.`), 2;
    return apps.signInApp(hub, app);
  }
  const gateway = await import("./lib/hub.ts");
  if (mode === "doctor") return (await gateway.doctor(hub)) ? 0 : 1;
  if (mode === "sign-in") await gateway.signIn(hub);
  if (mode === "restart") await gateway.restart(hub);
  if (mode === "reconnect") await gateway.reconnect(name!, hub);
  return 0;
}
