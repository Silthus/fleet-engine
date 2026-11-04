import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("GitHub Pages", () => {
  test("stages the committed page on every pull request and deploys it from main only once the repo is public", () => {
    const workflow = read(".github/workflows/pages.yml");
    expect(workflow).toContain("cp page/index.html _site/index.html");
    expect(workflow).toMatch(/deploy:\n(.*\n)*?\s+if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main' && !github\.event\.repository\.private\n/);
    for (const use of workflow.match(/uses: \S+/g) ?? []) expect(use).toMatch(/@[0-9a-f]{40}$/);
  });

  test("the README links the page", () => {
    expect(read("README.md")).toContain("https://silthus.github.io/fleet-engine/");
  });
});
