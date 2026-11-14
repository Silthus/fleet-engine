type Env = Record<string, string | undefined>;

export type Published = { id: string; url: string };
export type PublishRequest = { repository: string; pr: number; title: string; page: string; previous?: Published };
export type Publisher = (request: PublishRequest) => Promise<Published>;

export const publisherSeam = "proof-receipt";

const answerOf = (stdout: string) => {
  try { return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>; }
  catch { return {}; }
};

export function handlerPublisher(env: Env): Publisher | undefined {
  const handler = (JSON.parse(env.FLEET_HANDLERS || "{}") as Record<string, string>)[publisherSeam];
  if (!handler) return undefined;
  return async (request) => {
    const child = Bun.spawn(["bun", handler], { env: env as Record<string, string>, stdin: new Blob([JSON.stringify(request)]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const answer = answerOf(stdout);
    if (code === 0 && typeof answer.id === "string" && answer.id && typeof answer.url === "string" && /^https:\/\/\S+$/.test(answer.url)) return { id: answer.id, url: answer.url };
    const reason = typeof answer.failed === "string" ? answer.failed : stderr.trim().split("\n").at(-1) || `it ended with code ${code} and no id and URL`;
    throw new Error(`receipt: the ${publisherSeam} handler did not publish: ${reason}`);
  };
}
