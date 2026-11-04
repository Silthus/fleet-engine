import type { ThreadWord } from "../../base/lib/t3/index.ts";

export type { ThreadWord };
export type HeardAnswer = { thread: string; message: string; words: string; answered: string; at: string; source: ThreadWord["source"] };
export type ThreadWords = (thread: string) => Promise<ThreadWord[]>;
export type Hear = (answer: string) => Promise<HeardAnswer>;

export const normalized = (text: string) => text.toLowerCase().replace(/[`*_"“”‘’']/g, "").replace(/\s+/g, " ").trim();

const quotes = (answer: string) => [...answer.matchAll(/["“]([^"”]*)["”]/g)].map((match) => normalized(match[1]!)).filter(Boolean);

export const withoutThread: Hear = async () => {
  throw new Error("--override and --accept need --thread with the id of the T3 thread where the user gave the answer. A conductor may pass its own thread id");
};

export function listenIn(thread: string, threadWords: ThreadWords): Hear {
  return async (answer) => {
    const quoted = quotes(answer);
    if (!quoted.length) throw new Error(`Put the user's words in quotes, such as '2026-10-24 "Run round 7."'`);
    const said = (await threadWords(thread)).findLast((word) => normalized(word.text) === quoted.join(" "));
    if (!said) throw new Error(`"${quoted.join('" … "')}" is not in a message of the user's in thread ${thread}. Quote their whole message, so a refusal such as "Do not accept the gap." never reads as an acceptance. Only words they typed in T3, or their answer to a question tool in the T3 app, count`);
    return { thread: said.thread, message: said.id, words: said.text, answered: said.answered, at: said.at, source: said.source };
  };
}
