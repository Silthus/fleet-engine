import { parse } from "smol-toml";

/** An MCP server that the gateway signs in to with OAuth. tools, when set, is the only tools the Fleet group serves. */
export type OauthUpstream = { kind: "oauth"; name: string; title: string; url: string; tools?: string[] };

/**
 * A ChatGPT app that Fleet's app bridge serves through the Codex sign-in of its account. The bridge offers only the
 * tools its allowlist names, where a name may end in * for any rest, and refuses every other call with refusal.
 */
export type CodexApp = {
  kind: "codex-app";
  name: string;
  title: string;
  app: string;
  plugin: string;
  prefix: string;
  tools: string[];
  refusal: string;
  renames?: Record<string, string>;
  account?: string;
  skinTones?: boolean;
};

export type Upstream = OauthUpstream | CodexApp;

export const slack: CodexApp = {
  kind: "codex-app",
  name: "slack",
  title: "Slack",
  app: "asdk_app_69a1d78e929881919bba0dbda1f6436d",
  plugin: "slack@openai-curated-remote",
  prefix: "slack.",
  tools: ["slack_send_message_draft", "slack_create_canvas", "slack_update_canvas", "slack_get_reactions", "slack_read_*", "slack_search_*", "slack_list_*"],
  refusal: "Fleet's Slack bridge only reads Slack, leaves unsent drafts, and writes canvases. Use slack_send_message_draft and let the person send it.",
  renames: { slack_send_message: "slack_send_message_draft" },
  skinTones: true,
};

export const builtInApps: CodexApp[] = [slack];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function toolAllowed(app: Pick<CodexApp, "tools">, name: string) {
  return app.tools.some((tool) => (tool.endsWith("*") ? new RegExp(`^${escape(tool.slice(0, -1))}[a-z0-9_]+$`).test(name) : tool === name));
}

export function describe(app: Pick<CodexApp, "renames">, description: string) {
  return Object.entries(app.renames ?? {}).reduce((text, [from, to]) => text.replace(new RegExp(`\\b${escape(from)}\\b(?!_)`, "g"), to), description);
}

const quoted = (name: string) => (/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name));

export function backendArguments(config: string, app: CodexApp) {
  const settings = parse(config) as { mcp_servers?: Record<string, unknown>; plugins?: Record<string, unknown> };
  const off = Object.keys(settings.mcp_servers ?? {}).flatMap((name) => ["-c", `mcp_servers.${quoted(name)}.enabled=false`]);
  const plugins = Object.keys(settings.plugins ?? {}).flatMap((name) => ["-c", `plugins.${quoted(name)}.enabled=${name === app.plugin}`]);
  return ["-c", "features.apps=true", "-c", `apps.${app.app}.enabled=true`, "-c", 'model_provider="openai"', ...off, ...plugins, "app-server", "--stdio"];
}

const slug = /^[a-z0-9][a-z0-9-]*$/;
const toolName = /^[A-Za-z0-9_.-]+$/;
type Field = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" && value.trim() !== "";
const strings = (value: unknown) => Array.isArray(value) && value.every(text);

function problem(value: Field): string | undefined {
  if (value.kind !== "oauth" && value.kind !== "codex-app") return "kind must be oauth or codex-app";
  if (typeof value.name !== "string" || !slug.test(value.name)) return "name must be lowercase letters, digits and dashes";
  if (!text(value.title)) return "title must name the upstream";
  if (value.kind === "oauth") {
    if (typeof value.url !== "string" || !URL.canParse(value.url) || new URL(value.url).protocol !== "https:") return "url must be an https address";
    if (value.tools !== undefined && (!strings(value.tools) || !(value.tools as string[]).every((tool) => toolName.test(tool)))) return "tools of an oauth upstream must be exact tool names";
    return;
  }
  if (typeof value.app !== "string" || !/^[A-Za-z0-9_]+$/.test(value.app)) return "app must be a ChatGPT app id: letters, digits and underscores";
  if (typeof value.plugin !== "string" || !/^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*$/.test(value.plugin)) return "plugin must be a Codex plugin name such as name@marketplace";
  if (typeof value.prefix !== "string" || !/^[a-z0-9_]+\.$/.test(value.prefix)) return "prefix must be the app's tool prefix: lowercase letters, digits and underscores, then a dot";
  if (!strings(value.tools) || !(value.tools as string[]).every((tool) => toolName.test(tool.replace(/\*$/, "")))) return "tools must list tool names, each may end in *";
  if (!text(value.refusal)) return "refusal must be a sentence";
  if (value.renames !== undefined && !(typeof value.renames === "object" && value.renames !== null && Object.values(value.renames).every(text))) return "renames must map tool names to tool names";
  if (value.skinTones !== undefined && typeof value.skinTones !== "boolean") return "skinTones must be true or false";
  if (value.account !== undefined && (typeof value.account !== "string" || !slug.test(value.account))) return "account must be lowercase letters, digits and dashes";
}

export function parseUpstream(value: unknown): Upstream {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("must be one upstream object");
  const found = problem(value as Field);
  if (found) throw new Error(found);
  return value as Upstream;
}
