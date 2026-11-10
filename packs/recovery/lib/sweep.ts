import { listLocalThreads, recoveryScopes, sendContinue, withT3Session, type StoppedThread, type T3SessionOptions } from "../../base/lib/t3/index.ts";
import { currentAvailability, type Availability, type ProvidersContext, type Provider } from "./availability.ts";
import { isQuotaError } from "./quota.ts";

export type RecoverContext = ProvidersContext & { session?: T3SessionOptions };

const providerOf: Record<string, Provider> = { claudeAgent: "claude", codex: "codex" };

export async function recoverCommand(args: string[], context: RecoverContext): Promise<number> {
  if (args.length) return context.print("Usage: fleet recover"), 2;
  await withT3Session(async (client) => {
    const now = context.now();
    const limited = (await listLocalThreads(client)).filter((thread) => stoppedOnLimit(thread, now));
    if (!limited.length) return;
    const availability = await currentAvailability(context);
    for (const thread of limited) await continueLimited(client, thread, availability, context.print);
  }, { ...context.session, scopes: recoveryScopes });
  return 0;
}

async function continueLimited(client: Parameters<typeof sendContinue>[0], thread: StoppedThread, availability: Availability, print: (line: string) => void) {
  const provider = providerOf[thread.modelSelection.instanceId]!;
  const status = availability.providers[provider];
  const name = `${thread.title ?? "Untitled thread"} (${thread.id})`;
  if (status !== "available") return print(`${name}: waits for ${provider}, which is ${status}.`);
  await sendContinue(client, { threadId: thread.id, runId: thread.latestRunId!, commandId: `fleet-limit-resume:${thread.id}:${thread.latestRunId}`, continuesRun: thread.lastErrorClass === "usage_limit" });
  print(`${name}: continued after a usage limit; ${provider} is available.`);
}

export function stoppedOnLimit(thread: StoppedThread, now: number): boolean {
  if (thread.status !== "failed" || !thread.latestRunId || thread.latestRunStopRequested) return false;
  if (!providerOf[thread.modelSelection.instanceId] || thread.providerInstanceId !== thread.modelSelection.instanceId) return false;
  if (thread.limitRecovery?.autoResume === false) return false;
  return usageLimited(thread) && !held(thread, now);
}

export function usageLimited(thread: StoppedThread): boolean {
  if (thread.lastErrorClass === "usage_limit") return true;
  if (thread.lastErrorClass !== "provider_error" && thread.lastErrorClass !== "transport_error") return false;
  return isQuotaError(`${thread.lastErrorCode ?? ""} ${thread.lastError ?? ""}`);
}

export function held(thread: StoppedThread, now: number): boolean {
  return Boolean(thread.archivedAt || thread.deletedAt || thread.activeRunId || thread.pendingRuntimeRequest
    || thread.settledAt || thread.settledOverride === "settled"
    || (thread.snoozedUntil && Date.parse(thread.snoozedUntil) > now)
    || thread.lineage?.relationshipToParent === "subagent");
}
