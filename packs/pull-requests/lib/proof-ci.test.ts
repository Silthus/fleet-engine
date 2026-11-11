import { afterEach, expect, test } from "bun:test";
import { checkout, cleanFixtures, reviewHead } from "./proof-testing.ts";

afterEach(cleanFixtures);

async function reviewed() {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "docs only");
  return { pr, head };
}

const ciLine = (output: string) => output.split("\n").find((line) => line.startsWith("ci: "));

test("only the base branch's required checks decide CI, and the rest print as not required", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "test" }]);

  pr.ci([{ name: "test", bucket: "pass" }, { name: "lint", bucket: "fail" }, { name: "preview", bucket: "pending" }]);
  const advisory = await pr.fleet("gate");
  expect(advisory.code).toBe(0);
  expect(ciLine(advisory.output)).toBe("ci: green, 1 required check(s) pass; not required: failing: lint; 1 still running");

  pr.ci([{ name: "test", bucket: "fail" }, { name: "lint", bucket: "pass" }]);
  const red = await pr.fleet("gate");
  expect(red.code).toBe(1);
  expect(ciLine(red.output)).toStartWith("ci: red, required failing: test. Fix it");

  pr.ci([{ name: "lint", bucket: "pass" }]);
  const missing = await pr.fleet("gate");
  expect(missing.code).toBe(1);
  expect(ciLine(missing.output)).toBe("ci: pending, required not reported yet: test");
});

test("classic branch protection adds required checks, and a check from another app does not count for a pinned one", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "build", integration_id: 7 }], { classic: ["deploy"] });
  pr.statuses([{ context: "deploy", state: "success" }]);

  pr.ci([{ name: "build", bucket: "pass", app: 9 }]);
  const spoofed = await pr.fleet("gate");
  expect(spoofed.code).toBe(1);
  expect(ciLine(spoofed.output)).toBe("ci: pending, required not reported yet: build");

  pr.ci([{ name: "build", bucket: "pass", app: 7 }]);
  const green = await pr.fleet("gate");
  expect(ciLine(green.output)).toBe("ci: green, 2 required check(s) pass");
  expect(green.code).toBe(0);
});

test("a draft passes without a required check its workflow withholds from drafts, and a ready PR still needs it", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "Backend / Test results" }]);
  pr.pullRequestState({ draft: true });

  pr.ci([{ name: "Backend / Unit (1)", bucket: "pass" }, { name: "Backend / Unit (2)", bucket: "pending" }]);
  expect(ciLine((await pr.fleet("gate")).output)).toBe("ci: pending, required not reported yet: Backend / Test results");

  pr.ci([{ name: "Backend / Unit (1)", bucket: "pass" }, { name: "Backend / Unit (2)", bucket: "pass" }]);
  const withheld = await pr.fleet("gate");
  expect(withheld.code).toBe(0);
  expect(ciLine(withheld.output)).toBe("ci: green, 0 required check(s) pass; withheld from drafts, required once ready: Backend / Test results (its workflow finished without posting it)");

  pr.pullRequestState({ draft: false });
  expect(ciLine((await pr.fleet("gate")).output)).toBe("ci: pending, required not reported yet: Backend / Test results");
});

test("on a draft, a failed sibling does not withhold a required check", async () => {
  const { pr } = await reviewed();
  pr.pullRequestState({ draft: true });

  pr.required("main", [{ context: "Backend / Test results" }]);
  pr.ci([{ name: "Backend / Unit (1)", bucket: "pass" }, { name: "Backend / Unit (2)", bucket: "fail" }]);
  expect((await pr.fleet("gate")).code).toBe(1);
});

test("on a draft, a check from another app than the pinned one neither passes nor withholds it", async () => {
  const { pr } = await reviewed();
  pr.pullRequestState({ draft: true });
  pr.required("main", [{ context: "CI / test", integration_id: 7 }]);
  pr.ci([{ name: "CI / test", bucket: "pass", app: 9 }, { name: "CI / lint", bucket: "pass", app: 7 }]);
  const spoofed = await pr.fleet("gate");
  expect(spoofed.code).toBe(1);
  expect(ciLine(spoofed.output)).toBe("ci: pending, required not reported yet: CI / test");

  pr.ci([{ name: "CI / lint", bucket: "pass", app: 9 }]);
  expect(ciLine((await pr.fleet("gate")).output)).toBe("ci: pending, required not reported yet: CI / test");
});

test("a required check that two workflows report fails when either run fails", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "test" }]);
  pr.ci([{ name: "test", bucket: "fail" }, { name: "test", bucket: "pass" }]);
  expect(ciLine((await pr.fleet("gate")).output)).toStartWith("ci: red, required failing: test");
});

test("CI is unknown and nothing is cached when GitHub does not answer for the rulesets, and a plan without rulesets counts every check", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "pass" }, { name: "security", bucket: "fail" }]);
  pr.required("main", { error: "gh: Service Unavailable (HTTP 503)" }, { classic: ["test"] });
  const unknown = await pr.fleet("gate");
  expect(unknown.code).toBe(1);
  expect(ciLine(unknown.output)).toStartWith("ci: unknown, cannot read the rulesets of main over REST (gh: Service Unavailable (HTTP 503))");

  pr.required("main", [{ context: "security" }]);
  expect(ciLine((await pr.fleet("gate")).output)).toStartWith("ci: red, required failing: security");
});

test("a private repository whose plan has no rulesets still counts its classic protection", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "pass" }, { name: "lint", bucket: "fail" }]);
  pr.required("main", { error: "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)" }, { classic: ["test"] });
  const classic = await pr.fleet("gate");
  expect(ciLine(classic.output)).toBe("ci: green, 1 required check(s) pass; not required: failing: lint");
});

test("required checks on a later page of rules count", async () => {
  const { pr } = await reviewed();
  pr.required("main", [], { others: 100 });
  pr.required("main", [{ context: "security" }], { page: 2 });
  pr.ci([{ name: "test", bucket: "pass" }, { name: "security", bucket: "pending" }]);
  expect(ciLine((await pr.fleet("gate")).output)).toBe("ci: pending, required waiting on: security");
});

test("a stacked PR whose base requires nothing is held to the default branch's required checks", async () => {
  const { pr } = await reviewed();
  pr.pullRequestState({ base: "feature-base" });
  pr.required("main", [{ context: "test" }]);
  pr.ci([{ name: "test", bucket: "pending" }, { name: "lint", bucket: "pass" }]);
  expect(ciLine((await pr.fleet("gate")).output)).toBe("ci: pending, required waiting on: test (required by main; the base feature-base requires none)");
});

test("the gate finds the PR of the checkout and reads its head and required checks over REST, never through gh pr view", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "test" }]);
  const before = pr.githubCalls().length;
  expect((await pr.fleet("gate")).code).toBe(0);
  const calls = pr.githubCalls().slice(before);
  expect(calls).toContainEqual("api repos/example/product/pulls/42");
  expect(calls).toContainEqual(expect.stringMatching(/^api repos\/example\/product\/rules\/branches\/main/));
  expect(calls.filter((call) => call.startsWith("pr view"))).toEqual([]);
});
