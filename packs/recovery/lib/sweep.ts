import { listLocalThreads, recoveryScopes, sendContinue, withT3Session, type ContinueMessage, type StoppedThread, type T3Client, type T3SessionOptions } from "../../base/lib/t3/index.ts";
import { currentAvailability, type Availability, type ProvidersContext, type Provider } from "./availability.ts";
import { alertOutages, readOutageState, saveOutageState, type OutageEntry, type OutageState } from "./outage.ts";
import { isQuotaError } from "../../base/lib/quota.ts";

export type RecoverContext = ProvidersContext & { session?: T3SessionOptions };

const providerOf: Record<string, Provider> = { claudeAgent: "claude", codex: "codex" };
export const maxOutageTries = 4;
const firstOutageWaitMs = 5 * 60_000;
const outageError = /\bapi_error_5\d\d\b|\b(?:500|502|503|504|529)\b|auth_unavailable|provider_unavailable|overloaded|high demand/i;

type Sweep = { client: Pick<T3Client, "call">; context: RecoverContext; availability: () => Promise<Availability>; failed: boolean };

export async function recoverCommand(args: string[], context: RecoverContext): Promise<number> {
  if (args.length) return context.print("Usage: fleet recover"), 2;
  const failed = await withT3Session(async (client) => {
    const now = context.now();
    const threads = await listLocalThreads(client);
    let report: Promise<Availability> | undefined;
    const sweep: Sweep = { client, context, availability: () => (report ??= currentAvailability(context)), failed: false };
    for (const thread of threads.filter((candidate) => stoppedOnLimit(candidate, now))) await continueLimited(sweep, thread);
    await sweepOutages(sweep, threads, now);
    return sweep.failed;
  }, { ...context.session, scopes: recoveryScopes });
  return failed ? 1 : 0;
}

async function continueLimited(sweep: Sweep, thread: StoppedThread) {
  const provider = await availableProvider(sweep, thread);
  if (!provider) return;
  const sent = await send(sweep, thread, { threadId: thread.id, runId: thread.latestRunId!, commandId: `fleet-limit-resume:${thread.id}:${thread.latestRunId}`, continuesRun: thread.lastErrorClass === "usage_limit" });
  if (sent) sweep.context.print(`${label(thread)}: continued after a usage limit; ${provider} is available.`);
}

async function sweepOutages(sweep: Sweep, threads: StoppedThread[], now: number) {
  const { home } = sweep.context;
  const state = readOutageState(home);
  const next: OutageState = { version: 1, threads: {} };
  const ranOut: StoppedThread[] = [];
  for (const thread of threads) {
    const entry = state.threads[thread.id];
    if (entry && held(thread, now) && (thread.activeRunId || thread.status === "failed")) next.threads[thread.id] = entry;
    if (!stoppedByOutage(thread, now)) continue;
    const kept: OutageEntry = entry ?? { tries: 0 };
    next.threads[thread.id] = kept;
    if (kept.tries >= maxOutageTries) {
      if (!kept.alerted) ranOut.push(thread);
      continue;
    }
    const waitFrom = Math.max(Date.parse(thread.latestRunCompletedAt ?? "") || 0, Date.parse(kept.triedAt ?? "") || 0);
    if (now < waitFrom + firstOutageWaitMs * 2 ** kept.tries || !(await availableProvider(sweep, thread))) continue;
    const tries = kept.tries + 1;
    if (!(await send(sweep, thread, { threadId: thread.id, runId: thread.latestRunId!, commandId: `fleet-outage-resume:${thread.id}:${thread.latestRunId}:${tries}`, continuesRun: false }))) continue;
    next.threads[thread.id] = { tries, triedAt: new Date(now).toISOString() };
    sweep.context.print(`${label(thread)}: retried after a provider error, try ${tries} of ${maxOutageTries}.`);
  }
  if (ranOut.length) {
    const started = await alertOutages(ranOut.map((thread) => ({ name: label(thread), error: thread.lastError ?? thread.lastErrorCode ?? "provider error" })), sweep.context.env);
    if (started) for (const thread of ranOut) next.threads[thread.id] = { ...next.threads[thread.id]!, alerted: true };
    sweep.context.print(started ? `Started an alert thread for ${ranOut.length} threads out of tries.` : "Could not start the alert thread; the next sweep tries again.");
    if (!started) sweep.failed = true;
  }
  await saveOutageState(home, next);
}

async function availableProvider(sweep: Sweep, thread: StoppedThread): Promise<Provider | undefined> {
  const provider = providerOf[thread.modelSelection.instanceId]!;
  const status = (await sweep.availability()).providers[provider];
  if (status === "available") return provider;
  sweep.context.print(`${label(thread)}: waits for ${provider}, which is ${status}.`);
}

async function send(sweep: Sweep, thread: StoppedThread, message: ContinueMessage): Promise<boolean> {
  try {
    await sendContinue(sweep.client, message);
    return true;
  } catch (error) {
    sweep.context.print(`${label(thread)}: could not send a continue message: ${(error as Error).message}`);
    sweep.failed = true;
    return false;
  }
}

const label = (thread: StoppedThread) => `${thread.title ?? "Untitled thread"} (${thread.id})`;

function stoppedByError(thread: StoppedThread, now: number): boolean {
  if (thread.status !== "failed" || !thread.latestRunId || thread.latestRunStopRequested) return false;
  if (!providerOf[thread.modelSelection.instanceId] || thread.providerInstanceId !== thread.modelSelection.instanceId) return false;
  return !held(thread, now);
}

export function stoppedOnLimit(thread: StoppedThread, now: number): boolean {
  return stoppedByError(thread, now) && thread.limitRecovery?.autoResume !== false && usageLimited(thread);
}

export function stoppedByOutage(thread: StoppedThread, now: number): boolean {
  if (!stoppedByError(thread, now) || (thread.lastErrorClass !== "provider_error" && thread.lastErrorClass !== "transport_error")) return false;
  return outageError.test(`${thread.lastErrorCode ?? ""} ${thread.lastError ?? ""}`) && !usageLimited(thread);
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
