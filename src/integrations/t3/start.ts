import type { ModelRow } from "../../pack/types.ts";
import { launchScratchThread } from "./launch.ts";
import { withT3Session, type T3HttpClient, type T3SessionOptions } from "./session.ts";

export type ThreadStart = { key: string; title: string; prompt: string; modelRole: string };
export type StartedThread = { id: string; url?: string };
export type Threads = { start(def: ThreadStart): Promise<StartedThread> };

const startScopes = ["orchestration:read", "orchestration:operate", "access:read"];

export function t3Threads(models: ModelRow[], session: T3SessionOptions = {}): Threads {
  return {
    async start({ key, title, prompt, modelRole }) {
      const row = models.find((candidate) => candidate.role === modelRole);
      if (!row) throw new Error(`The model table of your AI plan has no ${modelRole} row, so Fleet cannot start the thread.`);
      return withT3Session(async (client) => {
        const id = await launchScratchThread(client, { title, prompt, row, commandId: key });
        const environment = await environmentOf(client);
        return environment ? { id, url: threadUrl(environment, id) } : { id };
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
