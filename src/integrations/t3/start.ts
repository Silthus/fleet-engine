import { homedir } from "node:os";
import type { ModelRow } from "../../pack/types.ts";
import type { StartedThread, Threads } from "../../sdk/index.ts";
import { exhaustedRefusal } from "./availability.ts";
import { launchScratchThread } from "./launch.ts";
import { findThread, sendMessage } from "./threads.ts";
import { withT3Session, type T3HttpClient, type T3SessionOptions } from "./session.ts";

const startScopes = ["orchestration:read", "orchestration:operate", "access:read"];

export function t3Threads(models: ModelRow[], session: T3SessionOptions = {}): Threads {
  return {
    async start({ key, title, prompt, modelRole }) {
      const row = models.find((candidate) => candidate.role === modelRole);
      if (!row) throw new Error(`The model table of your AI plan has no ${modelRole} row, so Fleet cannot start the thread.`);
      const refusal = exhaustedRefusal(session.home ?? homedir(), row, title, Date.now());
      if (refusal) throw new Error(refusal);
      let started: StartedThread | undefined;
      try {
        return await withT3Session(async (client) => {
          started = { id: await launchScratchThread(client, { title, prompt, row, commandId: key }) };
          const environment = await environmentOf(client);
          if (environment) started.url = threadUrl(environment, started.id);
          return started;
        }, { ...session, scopes: startScopes });
      } catch (error) {
        if (started) return started;
        throw error;
      }
    },
    async send({ id, text }) {
      await withT3Session(async (client) => {
        const thread = await findThread(client, id);
        if (!thread) throw new Error(`T3 has no thread ${id} on this machine.`);
        await sendMessage(client, thread, text);
      }, { ...session, scopes: startScopes });
    },
  };
}

export function threadUrl(environmentId: string, threadId: string) {
  return `https://app.t3.codes/threads/${environmentId}/${threadId}`;
}

async function environmentOf(client: T3HttpClient): Promise<string | undefined> {
  const answer = await client.get<{ environmentId?: unknown }>("/.well-known/t3/environment").catch(() => undefined);
  return typeof answer?.environmentId === "string" ? answer.environmentId : undefined;
}
