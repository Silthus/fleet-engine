import { describe, expect, test } from "bun:test";
import type { PackSetting } from "../pack/types.ts";
import { parseSetupFlags } from "./flags.ts";
import { settingSteps, type Catalog, type Draft } from "./questions.ts";

const region: PackSetting = {
  key: "team.region",
  question: "Where should your devbox run?",
  type: "choice",
  choices: [
    { value: "us", label: "US" },
    { value: "eu", label: "EU" },
  ],
  default: "us",
  defaultByTimeZone: { "Europe/": "eu", "America/": "us" },
  ask: "setup",
};

async function ask(timeZone: string, args: string[] = []) {
  const lines: string[] = [];
  const draft: Draft = {};
  const terminal = { print: (line: string) => void lines.push(line), ask: async () => "" };
  const context = { terminal, flags: parseSetupFlags(args), catalog: {} as Catalog, draft, timeZone, answer: async (fields: Draft) => void Object.assign(draft, fields) };
  await settingSteps(context, [region])[0]!.run();
  return { settings: draft.settings, output: lines.join("\n") };
}

describe("a setting's time-zone default", () => {
  test("picks eu in Europe/Berlin", async () => {
    const result = await ask("Europe/Berlin");
    expect(result.output).toContain("  2) EU (default)");
    expect(result.settings).toEqual({ "team.region": "eu" });
  });

  test("picks us in America/New_York", async () => {
    expect((await ask("America/New_York")).settings).toEqual({ "team.region": "us" });
  });

  test("falls back to the static default in a zone the map does not name", async () => {
    const result = await ask("Asia/Tokyo");
    expect(result.output).toContain("  1) US (default)");
    expect(result.settings).toEqual({ "team.region": "us" });
  });

  test("is saved without a person, so apply uses it too", async () => {
    expect((await ask("Europe/Berlin", ["--non-interactive"])).settings).toEqual({ "team.region": "eu" });
  });
});
