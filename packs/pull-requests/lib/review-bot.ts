type Env = Record<string, string | undefined>;
export type ReviewBotAction = "review" | "stamp";
export type ReviewBotRequest = { action: ReviewBotAction; repo: string; pr: number; minutes: number; deep: boolean };

const usage = "Usage: fleet pr review|stamp --repo <owner/repo> --pr <number> [--deep] [--minutes <n>]";
const fallbackSetting: Record<ReviewBotAction, string> = { review: "pull-requests.reviewFallback", stamp: "pull-requests.stampFallback" };
const defaultFallback: Record<ReviewBotAction, string> = {
  review: "Ask for a review the way the repo's docs say.",
  stamp: "Ask for an approval the way the repo's docs say.",
};

export function parseReviewBotArgs(action: ReviewBotAction, args: string[]): ReviewBotRequest {
  const request: Partial<ReviewBotRequest> = { action, minutes: 15, deep: false };
  const rest = [...args];
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === "--deep" && action === "review") { request.deep = true; continue; }
    const value = rest.shift();
    if (arg === "--repo" && value && /^[^/\s]+\/[^/\s]+$/.test(value)) { request.repo = value; continue; }
    if (arg === "--pr" && value && /^\d+$/.test(value)) { request.pr = Number(value); continue; }
    if (arg === "--minutes" && value && /^[1-9]\d*$/.test(value)) { request.minutes = Number(value); continue; }
    throw new Error(usage);
  }
  if (!request.repo || !request.pr) throw new Error(usage);
  return request as ReviewBotRequest;
}

export function handlerArgs(request: ReviewBotRequest): string[] {
  return [request.action, "--repo", request.repo, "--pr", String(request.pr), "--minutes", String(request.minutes), ...(request.deep ? ["--deep"] : [])];
}

export async function askReviewBot(request: ReviewBotRequest, env: Env = Bun.env): Promise<number> {
  const handler = (JSON.parse(env.FLEET_HANDLERS || "{}") as Record<string, string>)["review-bot"];
  if (handler) return runHandler(["bun", handler, ...handlerArgs(request)], env);
  const fallback = fallbackText(request.action, env);
  console.log(`No review bot is on for this machine. ${fallback.replaceAll("{repo}", request.repo).replaceAll("{pr}", String(request.pr))}`);
  return 2;
}

async function runHandler(command: string[], env: Env): Promise<number> {
  const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"], env });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forward).on("SIGTERM", forward);
  try { return await child.exited; }
  finally { process.off("SIGINT", forward).off("SIGTERM", forward); }
}

function fallbackText(action: ReviewBotAction, env: Env): string {
  const value = (JSON.parse(env.FLEET_SETTINGS || "{}") as Record<string, unknown>)[fallbackSetting[action]];
  return typeof value === "string" && value.trim() ? value : defaultFallback[action];
}
