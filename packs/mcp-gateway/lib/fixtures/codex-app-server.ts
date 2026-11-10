import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry: unknown) => appendFileSync(process.env.FAKE_CODEX_LOG!, `${JSON.stringify(entry)}\n`);
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tool = (name: string, description: string) => ({ name: `slack.${name}`, description, inputSchema: { type: "object" } });
const tools = {
  send: tool("slack_send_message", "Posts a message. Prefer slack_send_message over a reply."),
  draft: tool("slack_send_message_draft", "Leaves an unsent draft."),
  read: tool("slack_read_thread", "Reads a thread."),
  canvas: tool("slack_create_canvas", "Creates a canvas."),
  react: tool("slack_add_reaction", "Adds a reaction."),
  other: { name: "gmail.read_email", description: "Reads mail.", inputSchema: { type: "object" } },
};
const approvals = new Map<string, (result: unknown) => void>();

log({ argv: process.argv.slice(2) });
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown };
  if (message.method === undefined) return approvals.get(String(message.id))?.(message.result ?? message);
  log({ method: message.method, params: message.params });
  if (message.id === undefined) return;
  const reply = (result: unknown) => send({ id: message.id, result });
  if (message.method === "initialize") return reply({ userAgent: "fake" });
  if (message.method === "mcpServerStatus/list") return reply({ data: [{ name: "codex_apps", tools }] });
  if (message.method === "thread/start") return reply({ thread: { id: "thread-1" } });
  if (message.method !== "mcpServer/tool/call") return send({ id: message.id, error: { code: -32601, message: "unknown" } });
  const args = message.params!.arguments as { ask?: boolean };
  if (args.ask) {
    const answer = await new Promise((resolve) => {
      approvals.set("approval-1", resolve);
      send({ id: "approval-1", method: "mcpServer/elicitation/request", params: { mode: "form", message: "Leave this draft?", requestedSchema: { type: "object", properties: {} } } });
    });
    log({ approval: answer });
  }
  reply({ content: [{ type: "text", text: `${message.params!.tool} done` }], structuredContent: null });
});
