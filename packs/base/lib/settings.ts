type Env = Record<string, string | undefined>;

export function numberSetting(key: string, env: Env = Bun.env): number {
  return typed(key, "number", env) as number;
}

export function stringSetting(key: string, env: Env = Bun.env): string {
  return typed(key, "string", env) as string;
}

export function booleanSetting(key: string, env: Env = Bun.env): boolean {
  return typed(key, "boolean", env) as boolean;
}

function typed(key: string, type: "number" | "string" | "boolean", env: Env) {
  const value = resolvedSettings(env)[key];
  if (value === undefined) throw new Error(`setting ${key} is not declared by an enabled pack`);
  if (typeof value !== type) throw new Error(`setting ${key} is a ${typeof value}, not a ${type}`);
  return value;
}

function resolvedSettings(env: Env): Record<string, unknown> {
  if (!env.FLEET_SETTINGS) throw new Error("run this command as fleet <command>, so it gets your settings");
  return JSON.parse(env.FLEET_SETTINGS);
}
