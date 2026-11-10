import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "../files/private.ts";
import { t3Threads } from "../integrations/t3/index.ts";
import type { PackCode, Plan, Workflow } from "../pack/types.ts";
import type { Context, Secrets, Setting, Value } from "../sdk/index.ts";

export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export type ContextOptions = { home: string; plan: Plan; pack: string; code: PackCode; workflows: Workflow[]; print(line: string): void; clock: Clock };

const secretName = /^[a-z0-9][a-z0-9.-]*$/;

export async function packContext({ home, plan, pack, code, workflows, print, clock }: ContextOptions): Promise<Context> {
  const stateDir = join(home, ".local/state/fleet", pack);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const threads = t3Threads(plan.models, { home });
  return {
    get: <T extends Value>(setting: Setting<T>) => {
      const key = code.settingKey(setting);
      const value = plan.settings[key];
      if (value === undefined) {
        const listing = workflows.filter((workflow) => workflow.settings?.includes(key));
        const active = (workflow: Workflow) => plan.workflows.some((entry) => entry.id === workflow.id && entry.active);
        const off = listing.some(active) ? undefined : listing[0];
        throw new Error(off ? `${key} belongs to the ${off.name} workflow, which is off. Turn it on with fleet packs --workflows ${off.id}=on.` : `${key} has no value. Set it with fleet set ${key}=<value>.`);
      }
      return value as T;
    },
    secrets: secretStore(home, pack),
    stateDir,
    print,
    log: (line) => print(`${new Date(clock.now()).toISOString()} ${line}`),
    now: clock.now,
    sleep: clock.sleep,
    threads: { start: (request) => threads.start({ ...request, key: `${pack}:${request.key}` }) },
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
