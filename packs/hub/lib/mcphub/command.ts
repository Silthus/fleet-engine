import { bridge, type Write } from "./bridge.ts";
import { checkGateway, GatewayClientError, grantHint, readGatewayClient, saveGatewayClient } from "./client.ts";
import { doctor, grant, links, reconnect, restart, type Hub } from "./hub.ts";
import { install } from "./install.ts";

export type McphubDeps = Hub & { stdin: ReadableStream<Uint8Array>; write: Write; fail: (line: string) => void };

const usage = "Use fleet mcphub install|doctor|restart|links|check|connect, fleet mcphub reconnect <server>, or fleet mcphub grant <machine>.";
const plain = ["install", "doctor", "restart", "links", "check", "connect", "accept"];
const named = ["reconnect", "grant"];

export async function runMcphub(args: string[], deps: McphubDeps): Promise<number> {
  const [mode = "doctor", name, ...extra] = args;
  const fits = (plain.includes(mode) && name === undefined) || (named.includes(mode) && name !== undefined && extra.length === 0);
  if (!fits) return deps.fail(usage), 2;
  if (mode === "connect") return connect(deps);
  if (mode === "check") {
    const result = await checkGateway(deps.home, deps.gateway, deps.fetch);
    (result.ok ? deps.print : deps.fail)(result.line);
    return result.ok ? 0 : 1;
  }
  if (mode === "accept") {
    await saveGatewayClient(deps.home, JSON.parse(await new Response(deps.stdin).text()), deps.gateway);
    return deps.print("Saved the MCP gateway key."), 0;
  }
  if (mode === "doctor") return (await doctor(deps)) ? 0 : 1;
  if (mode === "install") await install(deps);
  if (mode === "restart") await restart(deps);
  if (mode === "links") await links(deps);
  if (mode === "reconnect") await reconnect(name!, deps);
  if (mode === "grant") await grant(name!, deps);
  return 0;
}

async function connect(deps: McphubDeps) {
  let client;
  try { client = await readGatewayClient(deps.home, deps.gateway); }
  catch (error) { if (error instanceof GatewayClientError) return deps.fail(error.message), 1; throw error; }
  if (!client) return deps.fail(`This machine has no MCP gateway key. ${grantHint}`), 1;
  return bridge({ client, stdin: deps.stdin, write: deps.write, fail: deps.fail, fetch: deps.fetch });
}
