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
  test("runs on every push to main, so the first push after the repo turns public deploys, and on pull requests that change the page", () => {
    const { on } = workflow();
    expect(on.push).toEqual({ branches: ["main"] });
    expect(on.pull_request?.paths).toEqual(expect.arrayContaining(["page/index.html", ".github/workflows/pages.yml"]));
    expect(on).toHaveProperty("workflow_dispatch");
  });

  test("stages the committed page as the Pages artifact", () => {
    const { stage } = workflow().jobs;
    expect(actions(stage)).toEqual(["actions/checkout", "actions/upload-pages-artifact"]);
    const upload = stage.steps.find((step) => step.uses?.startsWith("actions/upload-pages-artifact"))!;
    expect(stage.steps.some((step) => step.run === `mkdir ${upload.with!.path} && cp page/index.html ${upload.with!.path}/index.html`)).toBe(true);
  });

  test("deploys after staging, from main only, once the repo is public, with only the Pages permissions", () => {
    const { permissions, jobs } = workflow();
    expect(permissions).toEqual({ contents: "read" });
    expect(jobs.deploy).toMatchObject({
      needs: "stage",
      if: "github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && !github.event.repository.private",
      permissions: { pages: "write", "id-token": "write" },
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
    expect(uses).toHaveLength(4);
    for (const use of uses) expect(use).toMatch(/@[0-9a-f]{40}$/);
  });

  test("the README links the page", () => {
    expect(read("README.md")).toContain("https://silthus.github.io/fleet-engine/");
  });
});
