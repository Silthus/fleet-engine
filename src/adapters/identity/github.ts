import type { CommandRunner } from "../run.ts";

export type Identity = { login: string; name: string; email: string };
export type KeyType = "authentication" | "signing";

type User = { login: string; id: number; name: string | null; email: string | null };
type Email = { email: string; primary: boolean; verified: boolean; visibility: string | null };

const keyLists: Record<KeyType, string> = { authentication: "user/keys", signing: "user/ssh_signing_keys" };
const publicKeyLine = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/;

const unreadable = "GitHub answered with something Fleet cannot read";

function parse<T>(text: string, valid: (value: unknown) => boolean): T | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return valid(value) ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

const isUser = (value: unknown) => typeof (value as User)?.login === "string" && typeof (value as User).id === "number";

const failure = (result: { code: number; stderr?: string }) => (result.code === 127 ? "the GitHub CLI is not installed" : (result.stderr ?? "").trim() || `exit ${result.code}`);

export function keyFields(text: string | undefined) {
  const line = text?.trim();
  if (!line || !publicKeyLine.test(line)) return undefined;
  return line.split(" ").slice(0, 2).join(" ");
}

export async function githubIdentity(run: CommandRunner): Promise<Identity | { error: string }> {
  const result = await run(["gh", "api", "user"]);
  if (result.code !== 0) return { error: failure(result) };
  const user = parse<User>(result.stdout, isUser);
  if (!user) return { error: unreadable };
  const noreply = `${user.id}+${user.login}@users.noreply.github.com`;
  const listed = await run(["gh", "api", "user/emails"]);
  const emails = listed.code === 0 ? parse<Email[]>(listed.stdout, Array.isArray) : undefined;
  const primary = emails?.find((item) => item?.primary && item.verified && typeof item.email === "string");
  const email = primary?.visibility === "public" ? primary.email : emails ? noreply : user.email || noreply;
  return { login: user.login, name: user.name?.trim() || user.login, email };
}

export async function registeredKeys(run: CommandRunner, type: KeyType): Promise<string[] | { error: string }> {
  const result = await run(["gh", "api", "--paginate", "--jq", ".[].key", keyLists[type]]);
  if (result.code !== 0) return { error: failure(result) };
  return result.stdout.split("\n").flatMap((line) => keyFields(line) ?? []);
}

export async function registerKey(run: CommandRunner, file: string, type: KeyType, title: string) {
  const result = await run(["gh", "ssh-key", "add", file, "--type", type, "--title", title]);
  return result.code === 0 ? undefined : failure(result);
}

export function tokenScopes(status: string) {
  const line = status.split("\n").find((text) => text.includes("Token scopes:"));
  return line === undefined ? undefined : [...line.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

export async function workflowScopeMissing(run: CommandRunner) {
  const status = await run(["gh", "auth", "status", "--active", "--hostname", "github.com"]);
  if (status.code !== 0) return undefined;
  const text = `${status.stdout}\n${status.stderr ?? ""}`;
  const scopes = tokenScopes(text);
  if (!scopes?.length || scopes.includes("workflow")) return undefined;
  return { fromEnvironment: /\((GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)\)/.exec(text)?.[1] };
}
