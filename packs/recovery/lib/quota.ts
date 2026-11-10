const quotaText = /are cooling down|rate_limit_error|rate limit reached|usage limit|model_cooldown|\b429\b|too many requests/i;

export const isQuotaError = (text: string) => quotaText.test(text);
