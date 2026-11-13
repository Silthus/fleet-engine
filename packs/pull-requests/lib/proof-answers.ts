import { readThreadWords, t3UserData, withT3Session, type ThreadWord } from "../../base/lib/t3/index.ts";
import { t3StatePath } from "../../base/lib/prune.ts";

export type { ThreadWord };
export type HeardAnswer = { thread: string; message: string; words: string; answered: string; at: string; source: ThreadWord["source"] };
export type ThreadWords = (thread: string) => Promise<ThreadWord[]>;

export const normalized = (text: string) => text.toLowerCase().replace(/[`*_"“”‘’']/g, "").replace(/\s+/g, " ").trim();

export const t3ThreadWords = (home: string): ThreadWords => (thread) =>
  withT3Session((client) => readThreadWords(client, thread, t3StatePath(t3UserData(home))), { home })
    .catch((error: Error) => { throw new Error(`Cannot read T3 thread ${thread} (${error.message})`); });
