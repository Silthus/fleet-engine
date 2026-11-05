import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isScreenshot, saveProof, type ProofIdentity } from "./proof.ts";

export type GitHub = (path: string, body?: unknown, method?: string) => Promise<unknown>;

async function cached(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function publishProof(home: string, identity: ProofIdentity, source: string, repository: string, github: GitHub, recheck = false): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some((part) => part === "." || part === "..")) throw new Error("Invalid asset repository");
  const saved = await saveProof(home, identity, source);
  const bytes = await readFile(saved);
  if (!isScreenshot(saved, bytes)) throw new Error("Publish only screenshots with invented test data");
  const receiptPath = `${saved}.${repository.replace("/", "_")}.published.json`;
  const receipt = await cached(receiptPath);
  if (typeof receipt?.url === "string") return receipt.url;
  const { login } = await github("user") as { login: string };
  if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error("Cannot identify GitHub account");
  const capabilityPath = join(home, ".local/state/fleet/proof-publish", login, `${repository.replace("/", "_")}.json`);
  let capability = recheck ? undefined : await cached(capabilityPath);
  if (capability?.policyVersion !== 1 || capability.permitted !== false) capability = undefined;
  if (!capability) {
    try {
      const repo = await github(`repos/${repository}`) as { permissions?: { push?: boolean }; default_branch?: string; private?: boolean; owner?: { login?: string } };
      capability = { policyVersion: 1, permitted: repo.permissions?.push === true && repo.private === false && repo.owner?.login?.toLowerCase() === login.toLowerCase(), defaultBranch: repo.default_branch };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      capability = { policyVersion: 1, permitted: false };
    }
    if (!capability.permitted) {
      await mkdir(dirname(capabilityPath), { recursive: true, mode: 0o700 });
      await writeFile(capabilityPath, JSON.stringify(capability), { mode: 0o600 });
    }
  }
  if (!capability.permitted) throw new Error("Asset destination denied. Choose your writable fork, or use --recheck after access changes.");
  const branch = "fleet-proof";
  try { await github(`repos/${repository}/git/ref/heads/${branch}`); }
  catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    const base = await github(`repos/${repository}/git/ref/heads/${encodeURIComponent(String(capability.defaultBranch))}`) as { object: { sha: string } };
    try { await github(`repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha: base.object.sha }, "POST"); }
    catch (creationError) {
      if ((creationError as { status?: number }).status !== 422) throw creationError;
      await github(`repos/${repository}/git/ref/heads/${branch}`);
    }
  }
  const assetPath = `proof/${basename(saved)}`;
  let publishedCommit: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await github(`repos/${repository}/git/ref/heads/${branch}`) as { object: { sha: string } };
    try {
      let existing = await github(`repos/${repository}/contents/${assetPath}?ref=${ref.object.sha}`) as { encoding?: string; content?: string; sha?: string };
      if (existing.encoding === "none" && existing.sha && /^[0-9a-f]{40}$/.test(existing.sha)) existing = await github("repos/" + repository + "/git/blobs/" + existing.sha) as typeof existing;
      if (existing.encoding !== "base64" || typeof existing.content !== "string" || !Buffer.from(existing.content, "base64").equals(bytes)) throw new Error("Published asset differs from the saved proof");
      publishedCommit = ref.object.sha;
      break;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    try {
      const uploaded = await github(`repos/${repository}/contents/${assetPath}`, {
        message: "Add a proof screenshot",
        branch, content: bytes.toString("base64"),
      }, "PUT") as { commit?: { sha: string } };
      publishedCommit = uploaded.commit?.sha;
      break;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409 || status === 422) continue;
      throw error;
    }
  }
  if (!publishedCommit || !/^[0-9a-f]{40}$/.test(publishedCommit)) throw new Error("GitHub did not return the published commit; retry this saved proof");
  const url = `https://raw.githubusercontent.com/${repository}/${publishedCommit}/${assetPath}`;
  await writeFile(receiptPath, JSON.stringify({ ...identity, repository, url }) + "\n", { mode: 0o600 });
  return url;
}

export const githubRequest: GitHub = async (path, body, method = "GET") => {
  const child = Bun.spawn(["gh", "api", path, "--method", method, ...(body === undefined ? [] : ["--input", "-"])], { stdin: body === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (body !== undefined) { child.stdin!.write(JSON.stringify(body)); child.stdin!.end(); }
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw Object.assign(new Error(`GitHub API failed for ${path}`), { status: Number(/HTTP (\d+)/.exec(error)?.[1]) });
  return JSON.parse(output);
};
