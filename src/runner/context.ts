import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "../files/private.ts";
import { t3Threads } from "../integrations/t3/index.ts";
import { isSecretName } from "../pack/register.ts";
import type { PackCode, Plan, Workflow } from "../pack/types.ts";
import type { Context, Secrets, Setting, Value } from "../sdk/index.ts";

export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export type ContextOptions = { home: string; plan: Plan; pack: string; code: PackCode; workflows: Workflow[]; print(line: string): void; clock: Clock; stdin?: () => ReadableStream<Uint8Array> };

/** The secret that holds this machine's credential for a served service, in the serving pack's store. */
export const credentialName = (id: string) => `credential.${id}`;

export async function packContext({ home, plan, pack, code, workflows, print, clock, stdin = () => Bun.stdin.stream() }: ContextOptions): Promise<Context> {
  const stateDir = join(home, ".local/state/fleet", pack);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const threads = t3Threads(plan.models, { home });
  const secrets = secretStore(home, pack);
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
    secrets,
    stateDir,
    print,
    log: (line) => print(`${new Date(clock.now()).toISOString()} ${line}`),
    now: clock.now,
    sleep: clock.sleep,
    threads: { start: (request) => threads.start({ ...request, key: `${pack}:${request.key}` }), send: threads.send },
    stdin,
    use: async (service) => {
      const id = code.serviceId(service);
      const entry = plan.catalog?.find((item) => item.pack === pack && item.id === id);
      if (!entry) throw new Error(`the service catalog has no ${pack}/${id}: its workflow or plan is off in your profile.`);
      const credential = await secrets.read(credentialName(id));
      if (!credential) throw new Error(`${pack}/${id} has no credential on this machine yet. Run fleet apply on the hub.`);
      return { url: `http://127.0.0.1:${entry.port}`, credential };
    },
  };
}

export function secretStore(home: string, pack: string): Secrets {
  const dir = join(home, ".config/fleet/secrets", pack);
  const path = (name: string) => {
    if (!isSecretName(name)) throw new Error(`a secret's name is lowercase words joined by dashes or dots, not ${JSON.stringify(name)}`);
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
