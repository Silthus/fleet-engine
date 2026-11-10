import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";

const root = join(import.meta.dir, "..");
const guidePath = join(root, "docs/getting-started.md");
const read = (path: string) => readFileSync(path, "utf8");

async function fleetCommands() {
  let usage = "";
  await main(["help"], { home: "/nonexistent", engineRoot: root, platform: "linux", print: (line) => (usage += line) });
  return new Set([...usage.matchAll(/^ {2}fleet ([a-z]+)/gm)].map((match) => match[1]));
}

describe("the getting-started guide", () => {
  test("the README links it", () => {
    expect(existsSync(guidePath)).toBe(true);
    expect(read(join(root, "README.md"))).toContain("(docs/getting-started.md)");
  });

  test("walks from the install line to a linked devbox", () => {
    const guide = read(guidePath);
    expect(guide).toContain("curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/get.sh | sh");
    expect(guide).toContain("fleet devbox add");
    expect(guide).toContain("t3 up --connect");
  });

  test("runs only fleet commands that exist", async () => {
    const known = await fleetCommands();
    const used = [...read(guidePath).matchAll(/\bfleet ([a-z]+)\b/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((command) => !known.has(command))).toEqual([]);
  });
});
