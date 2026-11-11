import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { builtInApps, parseUpstream, type Upstream } from "./apps.ts";

export const upstreamsDir = (home: string) => join(home, ".config/fleet/mcp-gateway/upstreams");

const accountOf = (app: { name: string; account?: string }) => app.account ?? app.name;

function claimsBuiltIn(upstream: Upstream) {
  if (upstream.kind !== "codex-app") return undefined;
  return builtInApps.find((app) => app.app === upstream.app || app.plugin === upstream.plugin || accountOf(app) === accountOf(upstream));
}

/** Every upstream that a pack links into the hub's upstream folder, one JSON file each. */
export async function declaredUpstreams(home: string): Promise<Upstream[]> {
  const dir = upstreamsDir(home);
  const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const found: Upstream[] = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const path = join(dir, file);
    let value: unknown;
    try { value = JSON.parse(await readFile(path, "utf8")); }
    catch { throw new Error(`${path}: is not JSON`); }
    try {
      const upstream = parseUpstream(value);
      if (builtInApps.some((app) => app.name === upstream.name)) throw new Error(`name ${upstream.name} belongs to a built-in upstream`);
      const claimed = claimsBuiltIn(upstream);
      if (claimed) throw new Error(`app, plugin and account must differ from those of the built-in ${claimed.title}`);
      if (found.some((other) => other.name === upstream.name)) throw new Error(`name ${upstream.name} is declared twice`);
      found.push(upstream);
    } catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
  }
  return found;
}
