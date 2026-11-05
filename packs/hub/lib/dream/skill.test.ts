import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = (name: string) => readFileSync(join(import.meta.dir, "../../skills", name, "SKILL.md"), "utf8");
const memoryDir = "${FLEET_MEMORY_DIR:-$HOME/.agents/memory}";

test("the dream skill works out the memory checkout from FLEET_MEMORY_DIR once, and uses it for fetch, worktree, and cleanup", () => {
  const text = skill("dream");
  expect(text).toContain(`echo "${memoryDir}"`);
  expect(text.split(memoryDir).length).toBe(2);
  expect(text).not.toMatch(/~\/\.agents\/memory|\$HOME\/\.agents\/memory(?!\})/);
  expect(text).toContain('git -C <memory> fetch --quiet origin');
  expect(text).toContain('git -C <memory> worktree add <run>/memory -b dream/<date> origin/main');
  expect(text).toContain('git -C <memory> worktree remove <run>/memory');
});

test("the fleet-hub skill names no memory checkout path", () => {
  expect(skill("fleet-hub")).not.toMatch(/\.agents\/memory/);
});

test("the fleet-hub skill gives each devbox a total time limit, and a devbox that runs out is failed and skipped", () => {
  const text = skill("fleet-hub");
  const commands = text.split("\n").filter((line) => /^\s*(?:timeout \d+ )?ssh\b/.test(line));
  expect(commands.length).toBeGreaterThan(0);
  for (const line of commands) expect(line.trim()).toMatch(/^timeout 600 ssh -o BatchMode=yes -o ConnectTimeout=10 /);
  expect(text).toContain("exits 124");
  expect(text.replace(/\s+/g, " ")).toMatch(/report it as failed[^.]*and go on to the next devbox/i);
});
