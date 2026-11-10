import { join } from "node:path";
import { readProviderInstances, settingsScopes, upsertProviderInstance, withT3Session, type ProviderInstance, type T3SessionOptions } from "../../base/lib/t3/index.ts";

export type ClaudeWrapperContext = { home: string; print: (line: string) => void; session?: T3SessionOptions };

const defaultBinaries = ["", "claude"];

export const wrapperPath = (home: string) => join(home, ".config/fleet/recovery/claude");

export async function claudeWrapperCommand(args: string[], context: ClaudeWrapperContext): Promise<number> {
  const [mode] = args;
  if (args.length !== 1 || (mode !== "bind" && mode !== "check")) return context.print("Usage: fleet claude-wrapper bind|check"), 2;
  const wrapper = wrapperPath(context.home);
  return withT3Session(async (client) => {
    const unbound = claudeInstances(await readProviderInstances(client)).filter(([id, instance]) => {
      const binary = String(instance.config?.binaryPath ?? "");
      if (binary === wrapper) return false;
      if (defaultBinaries.includes(binary)) return true;
      context.print(`${id}: kept your Claude binary ${binary}.`);
      return false;
    });
    if (mode === "check") {
      for (const [id] of unbound) context.print(`${id}: T3 runs Claude without Fleet's reset wrapper. Run fleet apply.`);
      return unbound.length ? 1 : 0;
    }
    for (const [id, instance] of unbound) {
      await upsertProviderInstance(client, id, { ...instance, config: { ...instance.config, binaryPath: wrapper } });
      if ((await readProviderInstances(client))[id]?.config?.binaryPath !== wrapper) throw new Error(`T3 did not take the reset wrapper for ${id}`);
      context.print(`${id}: T3 runs Claude through Fleet's reset wrapper.`);
    }
    return 0;
  }, { ...context.session, scopes: settingsScopes });
}

function claudeInstances(instances: Record<string, ProviderInstance>): [string, ProviderInstance][] {
  const listed = Object.keys(instances).length ? instances : { claudeAgent: { driver: "claudeAgent" } };
  return Object.entries(listed).filter(([, instance]) => instance.driver === "claudeAgent" && instance.enabled !== false);
}
