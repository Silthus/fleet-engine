import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readProviderInstances, settingsScopes, upsertProviderInstance, withT3Session, type ProviderInstance, type T3SessionOptions } from "../../base/lib/t3/index.ts";

export type ClaudeWrapperContext = { home: string; print: (line: string) => void; session?: T3SessionOptions };

const defaultBinaries = ["", "claude"];

export const wrapperPath = (home: string) => join(home, ".config/fleet/recovery/claude");

const wrapperFiles = [{ name: "claude", mode: 0o755 }, { name: "claude-reset.ts", mode: 0o644 }];
const packBin = join(import.meta.dir, "../bin");

function read(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch { return undefined; }
}

function wrapperInstalled(home: string): boolean {
  const folder = dirname(wrapperPath(home));
  return wrapperFiles.every(({ name }) => read(join(folder, name)) === read(join(packBin, name)));
}

function installWrapper(home: string) {
  const folder = dirname(wrapperPath(home));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const { name, mode } of wrapperFiles) {
    const next = join(folder, `.${name}.next`);
    writeFileSync(next, readFileSync(join(packBin, name)));
    chmodSync(next, mode);
    renameSync(next, join(folder, name));
  }
}

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
    const installed = wrapperInstalled(context.home);
    if (mode === "check") {
      if (!installed) context.print("Fleet's Claude wrapper is missing or out of date. Run fleet apply.");
      for (const [id] of unbound) context.print(`${id}: T3 runs Claude without Fleet's reset wrapper. Run fleet apply.`);
      return unbound.length || !installed ? 1 : 0;
    }
    if (!installed) installWrapper(context.home);
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
