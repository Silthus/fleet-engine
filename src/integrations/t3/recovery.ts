import { readT3Settings, type T3Client } from "./session.ts";

export type StoppedThread = {
  id: string;
  title?: string;
  status: string;
  lastError?: string | null;
  lastErrorClass?: string | null;
  lastErrorCode?: string | null;
  latestRunId: string | null;
  latestRunCompletedAt?: string | null;
  latestRunStopRequested?: boolean;
  activeRunId?: string | null;
  providerInstanceId: string;
  modelSelection: { instanceId: string; model: string };
  pendingRuntimeRequest?: unknown;
  archivedAt?: string | null;
  deletedAt?: string | null;
  settledAt?: string | null;
  settledOverride?: string | null;
  snoozedUntil?: string | null;
  creationSource?: string;
  lineage?: { relationshipToParent?: string | null };
  limitRecovery?: { autoResume: boolean } | null;
};

export type ContinueMessage = { threadId: string; runId: string; commandId: string; continuesRun: boolean };

export const recoveryScopes = ["orchestration:read", "orchestration:operate", "access:read"];
export const continueText = "Continue where you left off.";

export async function listLocalThreads(client: Pick<T3Client, "getShell">): Promise<StoppedThread[]> {
  return (await client.getShell<{ threads: StoppedThread[] }>()).threads;
}

export async function sendContinue(client: Pick<T3Client, "call">, message: ContinueMessage): Promise<void> {
  await client.call("orchestration.dispatchCommand", {
    type: "message.dispatch",
    commandId: message.commandId,
    messageId: message.commandId,
    threadId: message.threadId,
    ...(message.continuesRun ? { manualContinuationOfRunId: message.runId } : {}),
    text: continueText,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  });
}

export type ProviderInstance = { driver: string; enabled?: boolean; config?: Record<string, unknown>; [field: string]: unknown };

export const settingsScopes: string[] = [];

export async function readProviderInstances(client: Pick<T3Client, "call">): Promise<Record<string, ProviderInstance>> {
  return (await readT3Settings<{ providerInstances?: Record<string, ProviderInstance> }>(client)).providerInstances ?? {};
}

export async function upsertProviderInstance(client: Pick<T3Client, "call">, instanceId: string, instance: ProviderInstance): Promise<void> {
  await client.call("server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId, instance } });
}
