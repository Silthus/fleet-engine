import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { main } from "../cli.ts";
import { tempDirs } from "../testing/git.ts";
import { engineSource, resolveEngine } from "../testing/packs.ts";
import { pageData } from "../../scripts/build-page.ts";
import { loadPacks } from "./manifest.ts";
import type { AvailableSource, MachineFile, Plan } from "./types.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const repoRoot = join(import.meta.dir, "../..");
const fixtures = join(import.meta.dir, "fixtures");

async function twin(form: "ts" | "json"): Promise<AvailableSource> {
  const dir = join(fixtures, `twin-${form}`);
  return { ref: { name: "twin", repo: "example/twin", ref: "main" }, dir, packs: await loadPacks(dir) };
}

function comparable(plan: Plan, source: AvailableSource) {
  const commands = Object.fromEntries(Object.entries(plan.commands).map(([name, { pack }]) => [name, pack]));
  return JSON.parse(JSON.stringify({ ...plan, commands }).replaceAll(source.dir, "<twin>"));
}

describe("a pack.ts", () => {
  const machines: Record<string, MachineFile> = { solo: { schema: 1, role: "linux" }, devbox: { schema: 1, role: "devbox" }, mac: { schema: 1, role: "mac" } };
  const profiles = { off: {}, on: { workflows: { "twin-hello": true }, settings: { "twin.greeting": "hi" } }, unanswered: { workflows: { "twin-hello": true } } };

  for (const [machine, file] of Object.entries(machines)) {
    for (const [answers, fields] of Object.entries(profiles)) {
      test(`resolves to the same plan as its pack.json twin on a ${machine} with the workflow ${answers}`, async () => {
        const engine = await engineSource();
        const [ts, json] = [await twin("ts"), await twin("json")];
        const plan = (source: AvailableSource) => comparable(resolveEngine([engine, source], { packs: ["twin"], plan: "claude", ...fields }, file), source);
        expect(plan(ts)).toEqual(plan(json));
      });
    }
  }

  test("is listed by fleet packs and by the page builder", async () => {
    const { fleet, lines } = machineWith({ twin: cpTwin });
    expect(await fleet("apply", "--profile", "<profile>")).toBe(0);
    expect(await fleet("packs")).toBe(0);
    expect(lines).toContain("  ✓ twin  The hub greets you once you pick a greeting.");
    const page = await pageData({ audience: "posthog", team: (await twin("ts")).packs });
    expect(page.packs.find((pack) => pack.name === "twin")).toMatchObject({ title: "Twin", summary: "The hub greets you once you pick a greeting." });
  });

  test("ships commands named like properties that every object has, and fleet knows no such command elsewhere", async () => {
    const named = { one: (dir: string) => writeFileSync(join(dir, "pack.ts"), `export default { sdk: 1, name: "one", summary: "A pack.", register(fleet) { fleet.command("toString", { summary: "Show.", run: async () => 0 }); fleet.command("constructor", { summary: "Build.", run: async () => 0 }); } };\n`) };
    const withNames = machineWith(named);
    expect(await withNames.fleet("apply", "--profile", "<profile>")).toBe(0);
    expect(await withNames.fleet("packs")).toBe(0);
    expect(withNames.lines).toContain("  ✓ one  A pack.");
    const without = machineWith({ twin: cpTwin });
    expect(await without.fleet("apply", "--profile", "<profile>")).toBe(0);
    expect([await without.fleet("toString"), without.lines.at(-1)?.split("\n")[0]]).toEqual([2, "fleet: unknown command toString"]);
  });
});

const cpTwin = (dir: string) => cpSync(join(fixtures, "twin-ts/packs/twin"), dir, { recursive: true });

function machineWith(packs: Record<string, (dir: string) => void>) {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  for (const [name, write] of Object.entries(packs)) {
    mkdirSync(join(engine, "packs", name), { recursive: true });
    write(join(engine, "packs", name));
  }
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: Object.keys(packs), plan: "both", settings: {}, workflows: {} }));
  const home = temp.make("home-");
  const bin = temp.make("bin-");
  for (const agent of ["claude", "codex"]) {
    writeFileSync(join(bin, agent), `#!/bin/sh\n[ "$*" = --version ] && echo "${agent} 1.0.0"\n`);
    chmodSync(join(bin, agent), 0o755);
  }
  const lines: string[] = [];
  const fleet = async (...args: string[]) => {
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      return await main(args.map((arg) => (arg === "<profile>" ? profile : arg)), { home, engineRoot: engine, platform: "linux", env: {}, print: (line) => lines.push(line) });
    } finally {
      process.env.PATH = path;
    }
  };
  return { fleet, lines };
}

describe("loading a pack.ts", () => {
  function source(packs: Record<string, string>, json: Record<string, string> = {}) {
    const dir = temp.make("source-");
    for (const [name, code] of Object.entries(packs)) {
      mkdirSync(join(dir, "packs", name), { recursive: true });
      writeFileSync(join(dir, "packs", name, "pack.ts"), code);
    }
    for (const [name, text] of Object.entries(json)) writeFileSync(join(dir, "packs", name, "pack.json"), text);
    return dir;
  }
  const pack = (name: string, register: string) => `export default { sdk: 1, name: "${name}", summary: "A pack.", register(fleet) { ${register} } };\n`;

  test("loads from a source path relative to the working directory", async () => {
    const packs = await loadPacks(relative(process.cwd(), join(fixtures, "twin-ts")));
    expect(packs.map((loaded) => loaded.manifest.summary)).toEqual(["The hub greets you once you pick a greeting."]);
  });

  test("fails when a directory has both a pack.ts and a pack.json", async () => {
    const dir = source({ one: pack("one", "") }, { one: JSON.stringify({ schema: 1, name: "one", summary: "A pack." }) });
    await expect(loadPacks(dir)).rejects.toThrow(`${join(dir, "packs/one")}: has both pack.json and pack.ts; keep one`);
  });

  test("refuses a handle that another pack made", async () => {
    const dir = source({
      a: pack("a", `globalThis.twinHandle = fleet.workflow({ id: "a-flow", name: "A", sentence: "A.", default: false });`),
      b: pack("b", `fleet.service({ when: globalThis.twinHandle, id: "b-run", run: async () => {} });`),
    });
    await expect(loadPacks(dir)).rejects.toThrow("service b-run names a workflow that the b pack did not declare");
  });

  test("refuses a handle that was never declared", async () => {
    const dir = source({ one: pack("one", `fleet.workflow({ id: "one-flow", name: "One", sentence: "One.", default: false, settings: [{}] });`) });
    await expect(loadPacks(dir)).rejects.toThrow("workflow one-flow names a setting that the one pack did not declare");
  });

  test("refuses a handle of another kind than the field takes", async () => {
    const dir = source({ one: pack("one", `const flow = fleet.workflow({ id: "one-flow", name: "One", sentence: "One.", default: false }); fleet.service({ after: flow, id: "one-run", run: async () => {} });`) });
    await expect(loadPacks(dir)).rejects.toThrow("service one-run names a check that the one pack did not declare");
  });

  test("refuses a recorded manifest that today's validation refuses", async () => {
    const dir = source({ one: pack("one", `fleet.setting({ key: "other.color", type: "string", question: "Which color?" });`) });
    await expect(loadPacks(dir)).rejects.toThrow("setting other.color must start with one.");
  });
});
