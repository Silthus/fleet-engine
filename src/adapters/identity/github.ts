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

/** The type and key fields of one SSH public key, or undefined for anything else. */
export function keyFields(text: string | undefined) {
  const line = text?.trim();
  if (!line || !publicKeyLine.test(line)) return undefined;
  return line.split(" ").slice(0, 2).join(" ");
}

/** The name and email for Git: the primary verified email, or the noreply address when GitHub keeps it private. */
export async function githubIdentity(run: CommandRunner): Promise<Identity | { error: string }> {
  const result = await run(["gh", "api", "user"]);
  if (result.code !== 0) return { error: failure(result) };
  const user = parse<User>(result.stdout, isUser);
  if (!user) return { error: unreadable };
  const noreply = `${user.id}+${user.login}@users.noreply.github.com`;
  const listed = await run(["gh", "api", "user/emails"]);
  const emails = listed.code === 0 ? parse<Email[]>(listed.stdout, Array.isArray) : undefined;
  const primary = emails?.find((item) => item?.primary && item.verified && typeof item.email === "string");
  const email = primary ? (primary.visibility === "private" ? noreply : primary.email) : user.email || noreply;
  return { login: user.login, name: user.name?.trim() || user.login, email };
}

export async function registeredKeys(run: CommandRunner, type: KeyType): Promise<string[] | { error: string }> {
  const result = await run(["gh", "api", keyLists[type]]);
  if (result.code !== 0) return { error: failure(result) };
  const keys = parse<Array<{ key?: unknown }>>(result.stdout, Array.isArray);
  if (!keys) return { error: unreadable };
  return keys.flatMap((item) => (typeof item?.key === "string" ? (keyFields(item.key) ?? []) : []));
}

export async function registerKey(run: CommandRunner, file: string, type: KeyType, title: string) {
  const result = await run(["gh", "ssh-key", "add", file, "--type", type, "--title", title]);
  return result.code === 0 ? undefined : failure(result);
}
