import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const engineRoot = join(import.meta.dir, "..");
const applyPathEntries = ["src/reconciler/apply.ts", "src/adapters/index.ts", "packs/memory/hooks/memory-index.ts", "packs/memory/hooks/memory-recall.ts", "packs/memory/sync/secret-scan.ts"];

function importGraph(entries: string[]) {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const reached = new Set<string>();
  const visit = (file: string) => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) if (path.startsWith(".")) visit(Bun.resolveSync(path, dirname(file)));
  };
  for (const entry of entries) visit(join(engineRoot, entry));
  return [...reached].map((file) => relative(engineRoot, file)).sort();
}

test("no module that fleet apply or the memory hooks load calls spawnSync, which can spin forever beside an async child", () => {
  const modules = importGraph(applyPathEntries);
  expect(modules).toEqual(expect.arrayContaining(["src/adapters/run.ts", "src/adapters/t3/session.ts", "src/adapters/identity/adapter.ts", "packs/memory/lib/notes.ts"]));
  expect(modules.filter((module) => readFileSync(join(engineRoot, module), "utf8").includes("spawnSync"))).toEqual([]);
});
