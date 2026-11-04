export const families = ["claude", "gpt"] as const;
export type Family = (typeof families)[number];

export function family(value: string): Family {
  if (!(families as readonly string[]).includes(value)) throw new Error(`Unknown author family ${value}. Use claude or gpt`);
  return value as Family;
}

export function sessionFamily(env: Record<string, string | undefined>): Family | undefined {
  const [claude, gpt] = [Boolean(env.CLAUDE_CODE_SESSION_ID), Boolean(env.CODEX_THREAD_ID)];
  return claude === gpt ? undefined : claude ? "claude" : "gpt";
}
