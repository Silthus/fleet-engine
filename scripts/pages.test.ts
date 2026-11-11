import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

type Step = { uses?: string; run?: string; id?: string; with?: Record<string, string> };
type Job = { needs?: string; if?: string; permissions?: Record<string, string>; environment?: { name: string }; steps: Step[] };
type Workflow = {
  on: { push?: { branches: string[]; paths?: string[] }; pull_request?: { paths?: string[] }; workflow_dispatch?: unknown };
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: { stage: Job; deploy: Job };
};

const workflow = () => Bun.YAML.parse(read(".github/workflows/pages.yml")) as Workflow;
const actions = (job: Job) => job.steps.flatMap((step) => (step.uses ? [step.uses.split("@")[0]] : []));

describe("GitHub Pages", () => {
  test("runs on every push to main, so the first push after the repo turns public deploys, and on every pull request, since the build reads the packs and the engine's own code", () => {
    const { on } = workflow();
    expect(on.push).toEqual({ branches: ["main"] });
    expect(on).toHaveProperty("pull_request", null);
    expect(on).toHaveProperty("workflow_dispatch");
  });

  test("builds the site from the pack data with the Bun version of CI, then uploads that folder as the Pages artifact", () => {
    const [checkout, bun, install, build, upload, ...rest] = workflow().jobs.stage.steps;
    expect([checkout!.uses?.split("@")[0], bun!.uses?.split("@")[0], upload!.uses?.split("@")[0], rest]).toEqual(["actions/checkout", "oven-sh/setup-bun", "actions/upload-pages-artifact", []]);
    const ci = Bun.YAML.parse(read(".github/workflows/ci.yml")) as { jobs: Record<string, Job> };
    const ciBun = Object.values(ci.jobs).flatMap((job) => job.steps).find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))!;
    expect(bun!.with).toEqual({ "bun-version": ciBun.with!["bun-version"]! });
    expect(install!.run).toBe("bun install --frozen-lockfile");
    expect(build!.run).toBe(`bun scripts/build-page.ts --out ${upload!.with!.path}`);
  });

  test("git ignores the folder a local build writes to, so the repository holds no built site", () => {
    expect(read(".gitignore").split("\n")).toContain("/site/");
  });

  test("deploys after staging, from main only, once the repo is public, with only the Pages permissions", () => {
    const { permissions, jobs } = workflow();
    expect(permissions).toEqual({ contents: "read" });
    expect(jobs.stage.permissions).toBeUndefined();
    expect(jobs.deploy.permissions).toEqual({ pages: "write", "id-token": "write" });
    expect(jobs.deploy).toMatchObject({
      needs: "stage",
      if: "github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && !github.event.repository.private",
      environment: { name: "github-pages" },
    });
    expect(actions(jobs.deploy)).toEqual(["actions/configure-pages", "actions/deploy-pages"]);
  });

  test("cancels only an older pull request run, never a running deploy", () => {
    expect(workflow().concurrency).toEqual({ group: "pages-${{ github.ref }}", "cancel-in-progress": "${{ github.event_name == 'pull_request' }}" });
  });

  test("pins every action to a full commit", () => {
    const { stage, deploy } = workflow().jobs;
    const uses = [...stage.steps, ...deploy.steps].flatMap((step) => (step.uses ? [step.uses] : []));
    expect(uses).toHaveLength(5);
    for (const use of uses) expect(use).toMatch(/@[0-9a-f]{40}$/);
  });

  test("the README links the page", () => {
    expect(read("README.md")).toContain("https://silthus.github.io/fleet-engine/");
  });
});
