import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "skills/dream/SKILL.md"), "utf8");

test("the dream skill finds the memory through memory.subtree, so a memory folder inside a larger repo is read where it is", () => {
  expect(skill).toContain("`memory.subtree`");
  expect(skill).toContain("`<notes>` is `<run>/memory/<memory.subtree>`, or `<run>/memory` when `memory.subtree` is empty.");
  expect([...skill.matchAll(/([^\s`]*)MEMORY\.md/g)].map((match) => match[1])).toEqual(["<notes>/"]);
  expect([...skill.matchAll(/`(projects|tech)\//g)]).toEqual([]);
});
