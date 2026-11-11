import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const readme = () => readFileSync(join(root, "README.md"), "utf8");
const rawMain = "https://raw.githubusercontent.com/Silthus/fleet-engine/main/";

function gettingStarted() {
  const text = readme();
  const start = text.indexOf("\n## Getting started\n");
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

function prompt() {
  const blocks = [...gettingStarted().matchAll(/^ *```\w*\n *(.+)\n *```$/gm)];
  expect(blocks.length).toBe(1);
  return blocks[0]![1]!;
}

describe("the README", () => {
  test("opens with a picture of Fleet that is in the repo", () => {
    const text = readme();
    const picture = text.match(/<img src="([^"]+)"/);
    expect(picture).not.toBeNull();
    expect(text.indexOf(picture![0])).toBeLessThan(text.indexOf("## Getting started"));
    expect(existsSync(join(root, picture![1]!))).toBe(true);
  });

  test("gets you started in exactly three steps", () => {
    const steps = [...gettingStarted().matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
    expect(steps).toEqual([1, 2, 3]);
  });

  test("gives one prompt that points at a setup guide on main that is in the repo", () => {
    const urls = [...prompt().matchAll(/https:\/\/\S+/g)].map((match) => match[0].replace(/[.,)]$/, ""));
    expect(urls.length).toBe(1);
    expect(urls[0]!.startsWith(rawMain)).toBe(true);
    expect(existsSync(join(root, urls[0]!.slice(rawMain.length)))).toBe(true);
  });

  test("its prompt link opens the same prompt in T3 Code", () => {
    const link = gettingStarted().match(/\(https:\/\/app\.t3\.codes\/new\?prompt=([^)\s]+)\)/);
    expect(link).not.toBeNull();
    expect(decodeURIComponent(link![1]!)).toBe(prompt());
  });
});
