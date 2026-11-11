const quotaText = /are cooling down|rate_limit_error|rate limit reached|usage limit|model_cooldown|\b429\b|too many requests/i;

export const isQuotaError = (text: string) => quotaText.test(text);

const modelCliLine = /^\s*(?:error:?\s*)?(?:reconnecting\.\.\.\s*\d+\/\d+|exceeded retry limit|stream (?:error|disconnected)|api error:|all credentials for model)/i;
const reconnecting = /reconnecting\.\.\./i;

export function quotaLine(line: string) {
  if (!modelCliLine.test(line)) return undefined;
  return reconnecting.test(line) || isQuotaError(line) ? line.trim().slice(0, 200) : undefined;
}

export const quotaGraceMs = 5 * 60_000;

export function quotaWatch(graceMs: number, exhausted: (line: string) => void) {
  let partial = "";
  let waiting: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { clearTimeout(timer); timer = undefined; };
  const judge = (line: string) => {
    if (!line.trim()) return;
    const quota = quotaLine(line);
    if (quota === undefined) { waiting = undefined; return stop(); }
    waiting = quota;
    timer ??= setTimeout(() => exhausted(quota), graceMs);
  };
  return {
    observe(chunk: string) {
      const lines = (partial + chunk).split(/\r\n|\r|\n/);
      partial = lines.pop() ?? "";
      lines.forEach(judge);
      if (quotaLine(partial) !== undefined) { judge(partial); partial = ""; }
    },
    waiting: () => waiting,
    stop,
  };
}
