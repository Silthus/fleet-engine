import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "../files/private.ts";
import { t3Threads } from "../integrations/t3/index.ts";
import type { PackCode, Plan } from "../pack/types.ts";
import type { Context, Secrets, Setting, Value } from "../sdk/index.ts";

export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export type ContextOptions = { home: string; plan: Plan; pack: string; code: PackCode; print(line: string): void; clock: Clock };

const secretName = /^[a-z0-9][a-z0-9.-]*$/;

export async function packContext({ home, plan, pack, code, print, clock }: ContextOptions): Promise<Context> {
  const stateDir = join(home, ".local/state/fleet", pack);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  return {
    get: <T extends Value>(setting: Setting<T>) => {
      const key = code.settings.get(setting);
      if (key === undefined) throw new Error(`the ${pack} pack asked for a setting it did not declare`);
      const value = plan.settings[key];
      if (value === undefined) throw new Error(`${key} has no value. Set it with fleet set ${key}=<value>.`);
      return value as T;
    },
    secrets: secretStore(home, pack),
    stateDir,
    print,
    log: (line) => print(`${new Date(clock.now()).toISOString()} ${line}`),
    now: clock.now,
    sleep: clock.sleep,
    threads: t3Threads(plan.models, { home }),
  };
}

export function secretStore(home: string, pack: string): Secrets {
  const dir = join(home, ".config/fleet/secrets", pack);
  const path = (name: string) => {
    if (!secretName.test(name)) throw new Error(`a secret's name is lowercase words joined by dashes or dots, not ${JSON.stringify(name)}`);
    return join(dir, name);
  };
  return {
    async read(name) {
      try {
        return await readFile(path(name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async write(name, value) {
      const file = path(name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      await writePrivateFile(file, value);
    },
  };
}
