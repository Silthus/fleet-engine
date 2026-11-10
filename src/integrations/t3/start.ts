import type { ModelRow } from "../../pack/types.ts";
import type { StartedThread, Threads } from "../../sdk/index.ts";
import { launchScratchThread } from "./launch.ts";
import { withT3Session, type T3HttpClient, type T3SessionOptions } from "./session.ts";

const startScopes = ["orchestration:read", "orchestration:operate", "access:read"];

export function t3Threads(models: ModelRow[], session: T3SessionOptions = {}): Threads {
  return {
    async start({ key, title, prompt, modelRole }) {
      const row = models.find((candidate) => candidate.role === modelRole);
      if (!row) throw new Error(`The model table of your AI plan has no ${modelRole} row, so Fleet cannot start the thread.`);
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
  };
}

export function threadUrl(environmentId: string, threadId: string) {
  return `https://app.t3.codes/threads/${environmentId}/${threadId}`;
}

async function environmentOf(client: T3HttpClient): Promise<string | undefined> {
  const answer = await client.get<{ environmentId?: unknown }>("/.well-known/t3/environment").catch(() => undefined);
  return typeof answer?.environmentId === "string" ? answer.environmentId : undefined;
}
