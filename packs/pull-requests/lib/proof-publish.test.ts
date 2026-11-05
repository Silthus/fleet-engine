import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishProof, type GitHub } from "./proof-publish.ts";

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const identity = { repository: "acme/secret-product", pr: 4242, commit: "c0ffee".padEnd(40, "0") };
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("invented pixels")]);
const branchHead = "1".repeat(40);
const published = "2".repeat(40);

function screenshot(name = "after.png", bytes: Buffer | string = png) {
  const home = mkdtempSync(join(tmpdir(), "fleet-publish-"));
  homes.push(home);
  const source = join(home, name);
  writeFileSync(source, bytes);
  return { home, source };
}

type Call = { path: string; body?: unknown; method: string };

function fakeGitHub(target: { private: boolean; owner: string }) {
  const calls: Call[] = [];
  const missing = () => Object.assign(new Error("Not Found"), { status: 404 });
  const github: GitHub = async (path, body, method = "GET") => {
    calls.push({ path, body, method });
    if (path === "user") return { login: "octocat" };
    if (path === "repos/octocat/assets") return { permissions: { push: true }, private: target.private, default_branch: "main", owner: { login: target.owner } };
    if (path.endsWith("/git/ref/heads/fleet-proof") || path.endsWith("/git/ref/heads/main")) return { object: { sha: branchHead } };
    if (path.includes("/contents/") && method === "GET") throw missing();
    if (path.includes("/contents/") && method === "PUT") return { commit: { sha: published } };
    throw missing();
  };
  return { github, calls, writes: () => calls.filter((call) => call.method !== "GET") };
}

test("publishing refuses a log renamed as a screenshot before contacting GitHub", async () => {
  const { home, source } = screenshot("capture.png", "Authorization: Bearer invented-token");
  const github: GitHub = async () => { throw new Error("Publication must stop before GitHub access"); };
  await expect(publishProof(home, identity, source, "octocat/assets", github)).rejects.toThrow("Publish only screenshots");
});

test("publishing writes only to the named public repository of the user's own account, and never names the PR, its repository, or its commit there", async () => {
  const { home, source } = screenshot();
  const denied = fakeGitHub({ private: true, owner: "octocat" });
  await expect(publishProof(home, identity, source, "octocat/assets", denied.github)).rejects.toThrow("Asset destination denied");
  expect(denied.writes()).toEqual([]);
  const foreign = fakeGitHub({ private: false, owner: "someone-else" });
  await expect(publishProof(home, identity, source, "octocat/assets", foreign.github, true)).rejects.toThrow("Asset destination denied");
  expect(foreign.writes()).toEqual([]);

  const open = fakeGitHub({ private: false, owner: "octocat" });
  const url = await publishProof(home, identity, source, "octocat/assets", open.github, true);
  expect(url).toMatch(new RegExp(`^https://raw\\.githubusercontent\\.com/octocat/assets/${published}/proof/[0-9a-f]{64}\\.png$`));
  expect(open.writes().map((call) => `${call.method} ${call.path}`)).toEqual([expect.stringMatching(/^PUT repos\/octocat\/assets\/contents\/proof\/[0-9a-f]{64}\.png$/)]);
  const denyList = [identity.repository, "acme", "secret-product", String(identity.pr), identity.commit, identity.commit.slice(0, 7), home];
  const sent = [url, ...open.calls.map(({ path, body }) => JSON.stringify({ path, body: body && { ...body as object, content: undefined } }))].join("\n");
  for (const term of denyList) expect(sent).not.toContain(term);
  expect(open.calls.every((call) => call.path === "user" || call.path.startsWith("repos/octocat/assets"))).toBe(true);

  const again = fakeGitHub({ private: false, owner: "octocat" });
  expect(await publishProof(home, identity, source, "octocat/assets", again.github)).toBe(url);
  expect(again.calls).toEqual([]);
});
