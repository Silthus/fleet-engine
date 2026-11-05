import { randomUUID } from "node:crypto";
import type { ModelRow } from "../models.ts";
import type { T3Client } from "./session.ts";

export type ThreadLaunch = { title: string; prompt: string; row: ModelRow; commandId?: string };

const instances = { claude: { instanceId: "claudeAgent", effort: "effort" }, codex: { instanceId: "codex", effort: "reasoningEffort" } } as const;
const launchTimeoutMs = 120_000;

export async function launchScratchThread(client: Pick<T3Client, "call">, launch: ThreadLaunch): Promise<string> {
  const { projectId } = await client.call<{ projectId: string }>("projects.ensureScratch", {});
  const instance = instances[launch.row.provider];
  const { threadId } = await client.call<{ threadId: string }>("orchestration.launchThread", {
    commandId: launch.commandId ?? randomUUID(),
    projectId,
    title: launch.title,
    generateTitle: false,
    modelSelection: { instanceId: instance.instanceId, model: launch.row.model, options: [{ id: instance.effort, value: launch.row.effort }] },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text: launch.prompt, attachments: [] },
  }, launchTimeoutMs);
  return threadId;
}
