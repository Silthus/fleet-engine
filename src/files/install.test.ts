import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, plan } from "./install.ts";

const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fleet-install-"));
  temporary.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const source = join(root, "skill");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "A shared skill.\n");
  return { root, home, source };
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("installation exposes files and links, then has no changes", async () => {
  const { home, source } = await fixture();
  const files = [{ target: ".agents/skills/example", source }, { target: ".config/example", content: "shared\n" }];
  expect((await plan(home, files)).map((action) => action.operation)).toEqual(["create", "create"]);
  await expect(lstat(join(home, ".agents"))).rejects.toThrow();
  await install(home, files);
  expect(await readFile(join(home, ".agents/skills/example/SKILL.md"), "utf8")).toBe("A shared skill.\n");
  expect(await readFile(join(home, ".config/example"), "utf8")).toBe("shared\n");
  expect((await install(home, files)).actions.map((action) => action.operation)).toEqual(["keep", "keep"]);
});

test("one unmanaged conflict stops every target change", async () => {
  const { home } = await fixture();
  await writeFile(join(home, "existing"), "personal");
  const files = [{ target: "new", content: "new" }, { target: "existing", content: "shared" }];
  await expect(install(home, files)).rejects.toThrow("existing");
  expect(await readFile(join(home, "existing"), "utf8")).toBe("personal");
  await expect(lstat(join(home, "new"))).rejects.toThrow();
  await expect(lstat(join(home, ".local/state/fleet/state.json"))).rejects.toThrow();
});

test("explicit adoption preserves the full replaced directory in a backup", async () => {
  const { home, source } = await fixture();
  await mkdir(join(home, "skill/nested"), { recursive: true });
  await writeFile(join(home, "skill/nested/local.txt"), "keep this");
  const result = await install(home, [{ target: "skill", source }], "core", { adopt: ["skill"] });
  expect(result.backupRoot).toBeDefined();
  expect(await readFile(join(result.backupRoot!, "skill/nested/local.txt"), "utf8")).toBe("keep this");
  expect(await readlink(join(home, "skill"))).toBe(source);
});

test("generated configuration updates preserve local edits", async () => {
  const { home } = await fixture();
  await install(home, [{ target: "settings", content: "version 1" }]);
  await install(home, [{ target: "settings", content: "version 2" }]);
  await writeFile(join(home, "settings"), "my edit");
  const next = [{ target: "settings", content: "version 3" }];
  expect(await plan(home, next)).toEqual([{ target: "settings", operation: "conflict", reason: "Managed file changed locally" }]);
  await expect(install(home, next)).rejects.toThrow();
  expect(await readFile(join(home, "settings"), "utf8")).toBe("my edit");
});

test("removed owned links are retired while unrelated files survive", async () => {
  const { home, source } = await fixture();
  await install(home, [{ target: "skills/retired", source }]);
  await writeFile(join(home, "skills/personal"), "personal skill");
  const result = await install(home, []);
  expect(result.actions).toEqual([{ target: "skills/retired", operation: "remove" }]);
  await expect(lstat(join(home, "skills/retired"))).rejects.toThrow();
  expect(await readFile(join(home, "skills/personal"), "utf8")).toBe("personal skill");
  expect(await readlink(join(result.backupRoot!, "skills/retired"))).toBe(source);
});

test("links follow a relocated source checkout", async () => {
  const { root, home, source } = await fixture();
  await install(home, [{ target: "skill", source }]);
  const moved = join(root, "moved-skill");
  await mkdir(moved);
  await writeFile(join(moved, "SKILL.md"), "new checkout");
  await rm(source, { recursive: true });
  const result = await install(home, [{ target: "skill", source: moved }]);
  expect(result.actions).toEqual([{ target: "skill", operation: "replace" }]);
  expect(await readFile(join(home, "skill/SKILL.md"), "utf8")).toBe("new checkout");
});

test("path traversal and linked parent directories cannot receive configuration", async () => {
  const { root, home } = await fixture();
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(home, ".config"));
  await expect(install(home, [{ target: ".config/settings", content: "shared" }])).rejects.toThrow("Resolve, adopt, or skip: .config/settings");
  await expect(install(home, [{ target: "../outside/settings", content: "shared" }])).rejects.toThrow("Path leaves its root");
  await install(home, [{ target: ".config/settings", content: "shared" }], "core", { adopt: [".config/settings"] });
  await expect(lstat(join(outside, "settings"))).rejects.toThrow();
  expect(await readFile(join(home, ".config/settings"), "utf8")).toBe("shared");
});

test("a failed adoption puts a linked folder it moved aside back", async () => {
  const { root, home } = await fixture();
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(home, ".config"));
  await expect(install(home, [
    { target: ".config/settings", content: "shared" },
    { target: `parent/${"x".repeat(256)}`, content: "cannot write" },
  ], "core", { adopt: [".config/settings"] })).rejects.toThrow();
  expect(await readlink(join(home, ".config"))).toBe(outside);
  await expect(lstat(join(outside, "settings"))).rejects.toThrow();
});

test("an operation failure rolls back earlier changes and keeps ownership state", async () => {
  const { home } = await fixture();
  await install(home, [{ target: "settings", content: "original" }]);
  const state = join(home, ".local/state/fleet/state.json");
  const before = await readFile(state, "utf8");
  // A missing parent passes inspection. Creating the long filename then fails.
  await expect(install(home, [
    { target: "settings", content: "updated" },
    { target: `parent/${"x".repeat(256)}`, content: "cannot write" },
  ])).rejects.toThrow();
  expect(await readFile(join(home, "settings"), "utf8")).toBe("original");
  expect(await readFile(state, "utf8")).toBe(before);
  expect((await lstat(join(home, "parent"))).isDirectory()).toBe(true);
  expect((await install(home, [{ target: "settings", content: "original" }])).actions[0]?.operation).toBe("keep");
});


test("managed targets cannot replace Fleet state through ancestors or aliases", async () => {
  const { home } = await fixture();
  await install(home, [{ target: "settings", content: "original" }]);
  const state = join(home, ".local/state/fleet/state.json");
  const before = await readFile(state, "utf8");
  for (const target of [".local", ".local/state", ".local/state/fleet", ".local/state/./fleet/state.json"]) {
    await expect(install(home, [
      { target: "settings", content: "updated" },
      { target, content: "would replace state" },
    ], "core", { adopt: [target] })).rejects.toThrow();
    expect(await readFile(state, "utf8")).toBe(before);
    expect(await readFile(join(home, "settings"), "utf8")).toBe("original");
  }
});
