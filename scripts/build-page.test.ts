import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedPack, PackManifest } from "../src/pack/types.ts";
import { tempDirs } from "../src/testing/git.ts";
import { presetPicks, commandFlags, setSetting, questions } from "../page/model.ts";
import { buildPage, pageData } from "./build-page.ts";

const root = join(import.meta.dir, "..");
const temp = tempDirs();
afterEach(() => temp.cleanup());

const teamPack = (manifest: Partial<PackManifest> = {}): LoadedPack => ({
  dir: "/team/packs/acme",
  manifest: {
    schema: 1,
    name: "posthog",
    summary: "A team pack.",
    audience: "posthog",
    workflows: [
      { id: "team-devbox", name: "Team devbox", sentence: "Setup makes a team devbox.", needs: ["posthog-org"], default: true, settings: ["posthog.region"], moment: { time: "08:45", title: "Your devbox is up", body: "It runs.", words: ["Coder"] } },
    ],
    settings: [{ key: "posthog.region", question: "Which region?", type: "choice", default: "us", ask: "setup", choices: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }] }],
    ...manifest,
  },
});

describe("the page build", () => {
  test("the committed public page is the generator's output", async () => {
    expect(await buildPage({ audience: "public" })).toBe(readFileSync(join(root, "page/index.html"), "utf8"));
  });

  test("the public build names no PostHog item, Coder, or hogli anywhere", async () => {
    const html = await buildPage({ audience: "public" });
    expect(html.match(/posthog|hogli|coder|stamphog|reviewhog/gi)).toBeNull();
    const data = await pageData({ audience: "public" });
    expect(data.packs.map((pack) => pack.name)).toEqual(["base", "pull-requests", "orchestration", "communication", "memory"]);
    expect(data.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id)).not.toContain("previews");
  });

  test("the public build refuses a private pack source", async () => {
    expect(pageData({ audience: "public", team: [teamPack()] })).rejects.toThrow("no pack from a private source");
  });

  test("a team build ticks the team pack in every preset and shows its words", async () => {
    const data = await pageData({ audience: "posthog", team: [teamPack()] });
    for (const preset of data.presets) expect([preset.id, presetPicks(data, preset.id).packs]).toEqual([preset.id, expect.arrayContaining(["posthog"])]);
    expect(data.concepts.map((concept) => concept.word)).toContain("Coder");
    expect(data.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id)).toContain("previews");
    const eu = setSetting(data, presetPicks(data, "everyday"), "posthog.region", "eu");
    expect(commandFlags(data, eu)).toEqual(["--preset", "everyday", "--set", "posthog.region=eu"]);
    expect(questions(data, eu).count).toBe(questions(data, presetPicks(data, "everyday")).count - 1);
  });

  test("a team build shows a pack by its title, and by its capitalised name without one", async () => {
    const data = await pageData({ audience: "posthog", team: [teamPack({ title: "PostHog" }), teamPack({ name: "acme", audience: undefined, workflows: [], settings: [] })] });
    expect(data.packs.filter((pack) => pack.name === "posthog" || pack.name === "acme").map((pack) => pack.title)).toEqual(["PostHog", "Acme"]);
    expect(data.teamNote).toStartWith("The PostHog and Acme pack");
  });

  test("a workflow that needs the hub shows only when a Hub pack is in the build", async () => {
    const boxes = { id: "boxes", name: "Boxes", sentence: "Heavy work runs on a box.", needs: ["hub" as const], default: true, moment: { time: "13:00", title: "Tests on a box", body: "A box runs them." } };
    const withHub = await pageData({ audience: "posthog", team: [teamPack({ name: "acme", audience: undefined, workflows: [boxes], settings: [] }), teamPack({ name: "hub", audience: undefined, workflows: [], settings: [] })] });
    expect(withHub.needPacks).toEqual({ hub: "hub" });
    const without = await pageData({ audience: "posthog", team: [teamPack({ name: "acme", audience: undefined, workflows: [boxes], settings: [] })] });
    expect(without.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id)).not.toContain("boxes");
  });

  test("the command line writes a build for a pack source to --out", async () => {
    const source = temp.make("source-");
    const manifest = teamPack().manifest;
    mkdirSync(join(source, "packs", "posthog"), { recursive: true });
    writeFileSync(join(source, "packs", "posthog", "pack.json"), JSON.stringify(manifest));
    const out = join(temp.make("out-"), "index.html");
    const run = Bun.spawnSync(["bun", join(root, "scripts/build-page.ts"), "--audience", "posthog", "--source", source, "--out", out], { cwd: root });
    expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
    expect(readFileSync(out, "utf8")).toContain('"teamPacks":["posthog"]');
  });
});
