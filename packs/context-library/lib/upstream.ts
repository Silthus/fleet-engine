import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LocalUpstream } from "../../mcp-gateway/lib/apps.ts";
import { upstreamsDir } from "../../mcp-gateway/lib/declared.ts";
import type { Library } from "./config.ts";

export const upstreamFile = (home: string) => join(upstreamsDir(home), "context.json");
export const serverScript = join(import.meta.dir, "../mcp/main.ts");
const target = "/fleet-context";

export function contextUpstream(library: Pick<Library, "path" | "url">): LocalUpstream {
  return {
    kind: "local", name: "context", title: "Context library", script: serverScript,
    mounts: [{ source: library.path, target }],
    env: { FLEET_CONTEXT_LIBRARY: target, ...(library.url ? { FLEET_CONTEXT_URL: library.url } : {}) },
  };
}

const declared = (home: string) => {
  try { return JSON.parse(readFileSync(upstreamFile(home), "utf8")) as unknown; } catch { return undefined; }
};

export function upstreamCommand(action: string | undefined, library: Library, home: string, print: (line: string) => void): number {
  const want = contextUpstream(library);
  if (action === "install") {
    mkdirSync(dirname(upstreamFile(home)), { recursive: true });
    writeFileSync(upstreamFile(home), `${JSON.stringify(want, null, 2)}\n`);
    print(`Context library: the MCP gateway serves context_search from ${library.path} once it applies ${upstreamFile(home)}.`);
    return 0;
  }
  if (action === "doctor") {
    if (Bun.deepEquals(declared(home), want)) return 0;
    print(`Context library: ${upstreamFile(home)} does not declare the context search for ${library.path}. Run: fleet context upstream install`);
    return 1;
  }
  if (action === "remove") {
    if (existsSync(upstreamFile(home))) rmSync(upstreamFile(home)), print(`Context library: removed ${upstreamFile(home)}.`);
    return 0;
  }
  return 2;
}
