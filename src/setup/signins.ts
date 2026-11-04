import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRow, SourceRef } from "../pack/types.ts";
import type { Machine } from "./commands.ts";
import type { SignIn } from "./human.ts";

export const githubScopes = ["repo", "read:org", "admin:public_key", "admin:ssh_signing_key"];

/** Team pack sources that setup offers to members of a GitHub org. */
export const teamSources: Array<{ org: string; source: SourceRef }> = [{ org: "PostHog", source: { name: "posthog", repo: "PostHog/fleet-posthog", ref: "main" } }];

export async function githubScopesMissing(machine: Machine): Promise<string[] | undefined> {
  const status = await machine.exec(["gh", "auth", "status", "--active", "--hostname", "github.com"]);
  if (status.code !== 0) return undefined;
  const line = status.output.split("\n").find((text) => text.includes("Token scopes:")) ?? "";
  const granted = [...line.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return githubScopes.filter((scope) => !granted.includes(scope));
}

export function githubSignIn(machine: Machine, signedIn: () => Promise<void>): SignIn {
  let refresh = false;
  return {
    id: "github",
    title: "Sign in to GitHub",
    minutes: 1,
    why: "Once, with every permission Fleet needs: your profile repo, your org's packs, and your keys.",
    url: "https://github.com/login/device",
    get command() {
      const scopes = githubScopes.join(",");
      return refresh ? ["gh", "auth", "refresh", "--hostname", "github.com", "--scopes", scopes] : ["gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", scopes];
    },
    async probe() {
      const missing = await githubScopesMissing(machine);
      refresh = missing !== undefined;
      return missing?.length === 0;
    },
    async after() {
      const git = await machine.exec(["gh", "auth", "setup-git"]);
      if (git.code !== 0) throw new Error(`gh auth setup-git failed: ${git.output.trim().split("\n").at(-1) ?? ""}`);
      await signedIn();
    },
  };
}

/** The team sources whose org this GitHub account belongs to. */
export async function memberSources(machine: Machine): Promise<SourceRef[]> {
  const sources: SourceRef[] = [];
  for (const { org, source } of teamSources) {
    const membership = await machine.exec(["gh", "api", `user/memberships/orgs/${org}`, "--jq", ".state"]);
    if (membership.code === 0 && membership.output.trim() === "active") sources.push(source);
  }
  return sources;
}

export function claudeSignIn(machine: Machine): SignIn {
  return {
    id: "claude",
    title: "Sign in to Claude",
    minutes: 1,
    why: "Each machine signs in to Claude itself. There is no shared proxy.",
    command: ["claude", "auth", "login"],
    async probe() {
      const status = await machine.exec(["claude", "auth", "status"]);
      if (status.code !== 0) return false;
      try {
        return (JSON.parse(status.output) as { loggedIn?: unknown }).loggedIn === true;
      } catch {
        return false;
      }
    },
  };
}

export const codexProbeTimeoutMs = 20_000;

export function chatgptSignIn(machine: Machine, models: ModelRow[]): SignIn {
  const model = (models.find((row) => row.provider === "codex" && row.role === "lookup") ?? models.find((row) => row.provider === "codex"))?.model;
  return {
    id: "chatgpt",
    title: "Sign in to ChatGPT",
    minutes: 1,
    why: "Codex signs in with your ChatGPT plan. Setup checks with a real request, because a stale sign-in still looks signed in.",
    command: ["codex", "login"],
    async probe() {
      const dir = mkdtempSync(join(tmpdir(), "fleet-codex-probe-"));
      try {
        const command = ["codex", "exec", "--ephemeral", "--sandbox", "read-only", "--ignore-user-config", "--skip-git-repo-check", ...(model ? ["--model", model] : []), "Reply with the word ok."];
        return (await machine.exec(command, { cwd: dir, timeoutMs: codexProbeTimeoutMs })).code === 0;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
