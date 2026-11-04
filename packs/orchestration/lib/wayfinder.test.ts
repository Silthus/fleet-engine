import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { mapRef, proseLines } from "./wayfinder.ts";

const usage = "Usage: fleet map";

test("a map is a URL, an owner/repo#number, or a number on the tracker", () => {
  const tracker = () => "acme/maps";
  expect(mapRef("https://github.com/globex/plans/issues/4", usage, tracker)).toEqual({ owner: "globex", repo: "plans", number: 4 });
  expect(mapRef("globex/plans#5", usage, tracker)).toEqual({ owner: "globex", repo: "plans", number: 5 });
  expect(mapRef("#6", usage, tracker)).toEqual({ owner: "acme", repo: "maps", number: 6 });
  expect(mapRef("7", usage, tracker)).toEqual({ owner: "acme", repo: "maps", number: 7 });
  expect(() => mapRef("7", usage)).toThrow("Set orchestration.mapTracker");
  expect(() => mapRef("maps", usage, tracker)).toThrow(usage);
});

test("the tracker is read only when the map names no repo", () => {
  const tracker = () => { throw new Error("tracker read"); };
  expect(mapRef("globex/plans#5", usage, tracker)).toEqual({ owner: "globex", repo: "plans", number: 5 });
  expect(() => mapRef("5", usage, tracker)).toThrow("tracker read");
});

test("prose lines skip fenced code", () => {
  expect(proseLines("a\n```\nb\n```\nc\n~~~ts\nd\n~~~")).toEqual(["a", "c"]);
});

test("the Orchestration pack hardcodes no repository, owner, or tracker", async () => {
  const root = join(import.meta.dir, "..");
  const files = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith("testing.ts"));
  const repositoryLiteral = /["'`](?:https:\/\/github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#\d+|\/issues)/;
  const githubOwner = /github\.com\/(?!\$\{)[A-Za-z0-9_-]+/;
  const hits = await Promise.all(files.map(async (path) => {
    const lines = (await readFile(join(root, path), "utf8")).split("\n");
    return lines.flatMap((line, index) => (repositoryLiteral.test(line) || githubOwner.test(line) ?[`${path}:${index + 1}`] : []));
  }));
  expect(files).toContain("lib/frontier.ts");
  expect(hits.flat()).toEqual([]);
});
