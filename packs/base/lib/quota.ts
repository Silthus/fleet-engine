const quotaText = /are cooling down|rate_limit_error|rate limit reached|usage limit|model_cooldown|\b429\b|too many requests/i;

export const isQuotaError = (text: string) => quotaText.test(text);

const modelCliLine = /^\s*(?:error:?\s*)?(?:reconnecting\.\.\.\s*\d+\/\d+|exceeded retry limit|stream (?:error|disconnected)|api error:|all credentials for model)/i;
const reconnecting = /reconnecting\.\.\./i;

export function quotaLine(line: string) {
  if (!modelCliLine.test(line)) return undefined;
  return reconnecting.test(line) || isQuotaError(line) ? line.replace(/\s+/g, " ").trim().slice(0, 200) : undefined;
}

export const quotaGraceMs = 5 * 60_000;

export function quotaWatch(graceMs: number, exhausted: (line: string) => void) {
  let streak = 0;
  let waiting: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const movedSinceQuota = new Set<object>();
  const stop = () => { clearTimeout(timer); timer = undefined; };
  const progress = () => { waiting = undefined; stop(); };
  const complete = (line: string, from: object, canStall: boolean) => {
    if (!line.trim()) return;
    const quota = quotaLine(line);
    if (quota === undefined) { streak = 0; movedSinceQuota.clear(); return progress(); }
    if ([...movedSinceQuota].some((stream) => stream !== from)) streak = 0;
    movedSinceQuota.clear();
    waiting = quota;
    streak += 1;
    if (canStall && streak >= 2) timer ??= setTimeout(() => exhausted(quota), graceMs);
  };
  const stream = () => {
    const self = {};
    let partial = "";
    return {
      observe(chunk: string) {
        const lines = (partial + chunk).split(/\r\n|\r|\n/);
        partial = lines.pop() ?? "";
        for (const line of lines) complete(line, self, true);
        if ((lines.length ? partial : chunk).trim()) { movedSinceQuota.add(self); progress(); }
      },
      end() { if (quotaLine(partial)) complete(partial, self, false); partial = ""; },
    };
  };
  return { stream, waiting: () => waiting, stop };
}
