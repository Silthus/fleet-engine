import { randomUUID } from "node:crypto";
import type { ModelRow } from "../models.ts";
import type { T3HttpClient } from "./session.ts";

export const launchScopes = ["orchestration:read", "orchestration:operate", "access:read"];

export type Launched = { threadId: string; environmentId?: string };

const launchTimeoutMs = 300_000;

function modelSelection(row: ModelRow) {
  return row.provider === "claude"
    ? { instanceId: "claudeAgent", model: row.model, options: [{ id: "effort", value: row.effort }] }
    : { instanceId: "codex", model: row.model, options: [{ id: "reasoningEffort", value: row.effort }] };
}

export async function launchScratchThread(client: T3HttpClient, { title, prompt, model }: { title: string; prompt: string; model: ModelRow }): Promise<Launched> {
  const { projectId } = await client.call<{ projectId: string }>("projects.ensureScratch", {});
  const { threadId } = await client.call<{ threadId: string }>("orchestration.launchThread", {
    commandId: randomUUID(),
    projectId,
    title,
    generateTitle: false,
    modelSelection: modelSelection(model),
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text: prompt, attachments: [] },
  }, launchTimeoutMs);
  const environmentId = await client.get<{ environmentId?: unknown }>("/.well-known/t3/environment").then((answer) => (typeof answer.environmentId === "string" ? answer.environmentId : undefined), () => undefined);
  return { threadId, environmentId };
}
