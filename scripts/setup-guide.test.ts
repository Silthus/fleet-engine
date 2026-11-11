import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { parseSetupFlags } from "../src/setup/flags.ts";

const root = join(import.meta.dir, "..");
const guide = () => readFileSync(join(root, "SETUP.md"), "utf8");
const presets = () => (JSON.parse(readFileSync(join(root, "presets.json"), "utf8")) as Array<{ id: string }>).map((preset) => preset.id);

async function fleetCommands() {
  let usage = "";
  await main(["help"], { home: "/nonexistent", engineRoot: root, platform: "darwin", print: (line) => (usage += `${line}\n`) });
  return new Set(["help", ...[...usage.matchAll(/^ {2}fleet ([a-z]+)/gm)].map((match) => match[1])]);
}

describe("the agent setup guide", () => {
  test("runs only fleet commands that exist", async () => {
    const known = await fleetCommands();
    const used = [...guide().matchAll(/`[^`]*\bfleet ([a-z]+)\b[^`]*`/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((command) => !known.has(command!))).toEqual([]);
  });

  test("drives fleet setup with flags that fleet setup takes, without asking the person anything", () => {
    const command = guide().match(/^fleet setup (.+)$/m);
    expect(command).not.toBeNull();
    for (const preset of presets()) {
      const args = command![1]!.replace("<id>", preset).replace("<claude|codex|both>", "both").split(" ");
      expect(parseSetupFlags(args)).toMatchObject({ preset, plan: "both", devbox: "skip", nonInteractive: true });
    }
  });

  test("fetches only files that are in the repo", () => {
    const paths = [...guide().matchAll(/https:\/\/raw\.githubusercontent\.com\/Silthus\/fleet-engine\/main\/(\S+?)[`)\s]/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });
});
