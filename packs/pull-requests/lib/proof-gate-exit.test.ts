import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { lastGateRun } from "./proof.ts";
import { checkout, cleanFixtures, reviewHead, verdict } from "./proof-testing.ts";

afterEach(cleanFixtures);

async function reviewed() {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  return { pr, head };
}

const lastLine = (output: string) => output.split("\n").at(-1);

test("a gate that misses its review names the missing check on its last line", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): review: no finished panel round on the PR. ");
});

test("a gate held only by a gap names the gap on its last line", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "fail" }]);
  await pr.hedge("gap", "--kind", "ci", "--reason", "Fork CI cannot create its token");
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(3);
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 3): ci: red, failing: test; ");
  expect(lastLine(gate.output)).toContain("Fork CI cannot create its token");
});

test("a failing judge names the question it failed on the gate's last line", async () => {
  const { pr } = await reviewed();
  pr.env.HEDGE_PROOF_JUDGE = `cat >/dev/null; echo '${verdict({ proof: { verdict: "fail", reason: "No evidence shows the greeting", citations: [] } })}'`;
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toBe("gate: fail (exit 1): judge proof: fail: No evidence shows the greeting");
});

test("an unavailable judge names its cause on the gate's last line", async () => {
  const { pr } = await reviewed();
  pr.env.HEDGE_PROOF_JUDGE = "cat >/dev/null; echo 'not json'";
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toBe("gate: fail (exit 1): judge: unavailable (unparseable answer: not json)");
});

test("a gate that throws prints the error as its last line on stdout and exits 1", async () => {
  const { pr } = await reviewed();
  rmSync(join(pr.home, ".agents/guides/coding-standards.md"));
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toBe("gate: fail (exit 1): ~/.agents/guides/coding-standards.md is missing or empty; it holds the coding standards to review against");
});

test("a gate that cannot find its commit prints why on stdout and exits 1", async () => {
  const { pr } = await reviewed();
  const gate = await pr.hedge("gate", "--commit", "no-such-commit");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toBe("gate: fail (exit 1): Cannot resolve commit no-such-commit here. Run in the PR checkout or pass the full SHA");
});

test("a gate with a bad option prints the usage error on stdout and exits 1", async () => {
  const { pr } = await reviewed();
  const gate = await pr.hedge("gate", "--wait", "soon");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): ");
  expect(lastLine(gate.output)).toContain("--wait takes a number of minutes");
});

test("a usage error with a line break still ends in one verdict line", async () => {
  const { pr } = await reviewed();
  const gate = await pr.hedge("gate", "--wait", "1\n2");
  expect(gate.code).toBe(1);
  expect(gate.output.split("\n")).toEqual([expect.stringMatching(/^gate: fail \(exit 1\): --wait takes a number of minutes/)]);
});

test("--wait refuses a limit past two hours", async () => {
  const { pr } = await reviewed();
  const gate = await pr.hedge("gate", "--wait", "1e308");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): --wait takes a number of minutes up to 120");
});

test("--json prints a usage error of the separator as JSON", async () => {
  const { pr } = await reviewed();
  const gate = await pr.hedge("gate", "--json", "--");
  expect(gate.code).toBe(1);
  expect(JSON.parse(gate.output)).toEqual({ code: 1, reason: "Unknown option --. Run hedge proof gate --help." });
});

test("--json carries the reason of a failure, and of a failure that throws", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "fail" }]);
  const red = await pr.hedge("gate", "--json");
  expect(red.code).toBe(1);
  expect(JSON.parse(red.output)).toMatchObject({ code: 1, reason: expect.stringMatching(/^ci: red, failing: test\. Fix it/) });

  pr.ci([{ name: "test", bucket: "pass" }]);
  rmSync(join(pr.home, ".agents/guides/coding-standards.md"));
  const thrown = await pr.hedge("gate", "--json");
  expect(thrown.code).toBe(1);
  expect(JSON.parse(thrown.output)).toEqual({ code: 1, reason: "~/.agents/guides/coding-standards.md is missing or empty; it holds the coding standards to review against" });
});

test("CI that is still running exits 75, names the checks it waits on and how to wait, and records the wait", async () => {
  const { pr, head } = await reviewed();
  pr.required("main", [{ context: "test" }]);
  pr.ci([{ name: "test", bucket: "pending" }]);
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(75);
  expect(lastLine(gate.output)).toBe("gate: pending (exit 75): CI is still running: required waiting on: test. Run the gate again with --wait <minutes>, such as --wait 10, to wait for CI to finish");
  expect(await lastGateRun(pr.home, { repository: "example/product", pr: 42, commit: head })).toEqual({ code: 75, reason: "CI is still running: required waiting on: test" });
});

test("CI still running beside a missing proof fails the gate on the missing proof", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  pr.ci([{ name: "test", bucket: "pending" }]);
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): review: no finished panel round on the PR. ");
});

test("--wait waits for running CI to finish, then gates on its outcome", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "pending" }]);
  let polls = 0;
  pr.panel.onPause = async () => {
    polls++;
    pr.clock.now = new Date(pr.clock.now.getTime() + 30_000);
    if (polls === 3) pr.ci([{ name: "test", bucket: "pass" }]);
  };
  const gate = await pr.hedge("gate", "--wait", "10");
  expect(gate.code).toBe(0);
  expect(lastLine(gate.output)).toStartWith("gate: pass (");
});

test("--wait stops at its limit, exits 75, and names only the checks that still run then", async () => {
  const { pr, head } = await reviewed();
  pr.ci([{ name: "build", bucket: "pending" }, { name: "test", bucket: "pending" }]);
  pr.panel.onPause = async () => {
    pr.clock.now = new Date(pr.clock.now.getTime() + 60_000);
    pr.ci([{ name: "build", bucket: "pass" }, { name: "test", bucket: "pending" }]);
  };
  const gate = await pr.hedge("gate", "--wait", "2");
  expect(gate.code).toBe(75);
  expect(lastLine(gate.output)).toStartWith("gate: pending (exit 75): CI is still running: waiting on: test. ");
  expect(await lastGateRun(pr.home, { repository: "example/product", pr: 42, commit: head })).toEqual({ code: 75, reason: "CI is still running: waiting on: test" });
});

test("--wait sleeps no longer than its limit", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "pending" }]);
  pr.panel.onPause = async (ms = 0) => { pr.clock.now = new Date(pr.clock.now.getTime() + ms); };
  const started = pr.clock.now.getTime();
  const gate = await pr.hedge("gate", "--wait", "0.1");
  expect(gate.code).toBe(75);
  expect(pr.clock.now.getTime() - started).toBe(6_000);
});

test("a wait that a failed read of GitHub ended early says so, though CI still runs", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "pending" }]);
  const github = join(dirname(pr.home), "github");
  pr.panel.onPause = async () => {
    pr.pullRequestState({ unreadable: "gh: Bad Gateway (HTTP 502)" });
    pr.whileGithubReadsPull(`echo 'rm -f "${github}/pull-error-42"' > "${github}/while-reading"`);
  };
  const gate = await pr.hedge("gate", "--wait", "10");
  expect(gate.code).toBe(75);
  expect(gate.output).toContain("ci: --wait stopped early at a failed read of GitHub: gh api repos/example/product/pulls/42 failed (gh: Bad Gateway (HTTP 502))");
  expect(lastLine(gate.output)).toStartWith("gate: pending (exit 75): ");
});

test("a wait that a failed read ended early says so also when CI turned red by the next read", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "pending" }]);
  const github = join(dirname(pr.home), "github");
  pr.panel.onPause = async () => {
    pr.pullRequestState({ unreadable: "gh: Bad Gateway (HTTP 502)" });
    pr.whileGithubReadsPull(`echo 'rm -f "${github}/pull-error-42"' > "${github}/while-reading"`);
    pr.ci([{ name: "test", bucket: "fail" }]);
  };
  const gate = await pr.hedge("gate", "--wait", "10");
  expect(gate.code).toBe(1);
  expect(gate.output).toContain("ci: --wait stopped early at a failed read of GitHub: gh api repos/example/product/pulls/42 failed (gh: Bad Gateway (HTTP 502))");
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): ci: red, failing: test. ");
});

test("while --wait waits, the gate record says CI is still running", async () => {
  const { pr, head } = await reviewed();
  pr.ci([{ name: "test", bucket: "pending" }]);
  const seen: unknown[] = [];
  pr.panel.onPause = async () => {
    seen.push(await lastGateRun(pr.home, { repository: "example/product", pr: 42, commit: head }));
    pr.ci([{ name: "test", bucket: "pass" }]);
  };
  expect((await pr.hedge("gate", "--wait", "10")).code).toBe(0);
  expect(seen[0]).toEqual({ code: 75, reason: "CI is still running: waiting on: test" });
});

test("--wait stops at a failed read of GitHub and names it", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "pending" }]);
  pr.panel.onPause = async () => {
    pr.clock.now = new Date(pr.clock.now.getTime() + 30_000);
    pr.pullRequestState({ unreadable: "gh: Bad credentials (HTTP 401)" });
  };
  const started = pr.clock.now.getTime();
  const gate = await pr.hedge("gate", "--wait", "10");
  expect(gate.code).toBe(1);
  expect(pr.clock.now.getTime() - started).toBe(30_000);
  expect(lastLine(gate.output)).toBe("gate: fail (exit 1): head: cannot read the PR head on GitHub (gh api repos/example/product/pulls/42 failed (gh: Bad credentials (HTTP 401)))");
});

test("--wait ends on CI that turns red and fails the gate on it", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "pending" }]);
  pr.panel.onPause = async () => { pr.ci([{ name: "test", bucket: "fail" }]); };
  const gate = await pr.hedge("gate", "--wait", "10");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): ci: red, failing: test. Fix it");
});
