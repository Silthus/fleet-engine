import { parse } from "smol-toml";

export const slackApp = { id: "asdk_app_69a1d78e929881919bba0dbda1f6436d", plugin: "slack@openai-curated-remote", prefix: "slack." };

const writes = new Set(["slack_send_message_draft", "slack_create_canvas", "slack_update_canvas"]);

export const refusal = "Fleet's Slack bridge only reads Slack, leaves unsent drafts, and writes canvases. Use slack_send_message_draft and let the person send it.";

export function slackToolAllowed(name: string) {
  return writes.has(name) || name === "slack_get_reactions" || /^slack_(read|search|list)_[a-z_]+$/.test(name);
}

export function draftOnly(description: string) {
  return description.replace(/\bslack_send_message\b(?!_)/g, "slack_send_message_draft");
}

const quoted = (name: string) => (/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name));

export function backendArguments(config: string) {
  const settings = parse(config) as { mcp_servers?: Record<string, unknown>; plugins?: Record<string, unknown> };
  const off = Object.keys(settings.mcp_servers ?? {}).flatMap((name) => ["-c", `mcp_servers.${quoted(name)}.enabled=false`]);
  const plugins = Object.keys(settings.plugins ?? {}).flatMap((name) => ["-c", `plugins.${quoted(name)}.enabled=${name === slackApp.plugin}`]);
  return ["-c", "features.apps=true", "-c", `apps.${slackApp.id}.enabled=true`, "-c", 'model_provider="openai"', ...off, ...plugins, "app-server", "--stdio"];
}
