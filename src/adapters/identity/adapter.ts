import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { inside } from "../../files/install.ts";
import type { Finding, Plan } from "../../pack/types.ts";
import type { Adapter, AdapterResult } from "../../reconciler/apply.ts";
import { linkOnPath, readState, withLock, writeWithBackups, type Write } from "../provider-config/store.ts";
import { isAccountHome, spawnRunner, type CommandRunner } from "../run.ts";
import { allowedSigners, fleetGitconfig, gitconfig, withInclude } from "./gitconfig.ts";
import { githubIdentity, keyFields, registeredKeys, registerKey } from "./github.ts";
import { coderScript, signer, signerNames, signerSetting, sshKeyTarget, type Signer, type SignerName } from "./signers.ts";

export { signerSetting } from "./signers.ts";

export type IdentityOptions = { run?: CommandRunner; engineRoot?: string; hostname?: string };

type Context = { home: string; dryRun: boolean; run: CommandRunner; result: AdapterResult; host: string; engineRoot: string };

const finding = (id: string, say: string, repair: Finding["repair"] = "apply"): Finding => ({ id: `identity:${id}`, pack: "engine", say, repair });

export function identityAdapter(options: IdentityOptions = {}): Adapter {
  const run = options.run ?? spawnRunner;
  const engineRoot = options.engineRoot ?? join(import.meta.dir, "..", "..", "..");
  const host = options.hostname ?? hostname();
  return {
    name: "identity",
    targets: () => [],
    async apply(plan, { home, dryRun }) {
      const result: AdapterResult = { actions: [], findings: [] };
      if (!options.run && !isAccountHome(home)) return result;
      const name = String(plan.settings[signerSetting] ?? "ssh");
      if (!signerNames.includes(name as SignerName)) {
        result.findings.push(finding("signer", `${signerSetting} is ${name}. Use ${signerNames.slice(0, -1).join(", ")}, or ${signerNames.at(-1)}.`, "human"));
        return result;
      }
      const context: Context = { home, dryRun, run, result, host, engineRoot };
      const reconcile = async () => (await reconcileIdentity(plan, signer(name as SignerName, home, plan.os, engineRoot), context), result);
      return dryRun ? reconcile() : withLock(home, reconcile);
    },
  };
}

async function reconcileIdentity(plan: Plan, signer: Signer, context: Context) {
  const { home, dryRun, run, result } = context;
  for (const target of [fleetGitconfig, allowedSigners, signer.publicKey, ...(signer.name === "ssh" ? [sshKeyTarget] : [])]) {
    const link = await linkOnPath(home, target);
    if (link) return void result.findings.push(finding("link", `Left your Git identity alone: ${link} is a link. Fleet writes keys and Git settings only through plain folders.`, "human"));
  }
  const identity = await githubIdentity(run);
  if ("error" in identity) return void result.findings.push(finding("github", `Your Git identity waits for the GitHub sign-in (${identity.error}). Run gh auth login, then fleet apply.`, "human"));
  const key = await signingKey(signer, context);
  if (key === null) return;
  const wanted: Write[] = [{ target: fleetGitconfig, after: gitconfig(home, identity, signer) }];
  if (key.write) wanted.push(key.write);
  if (key.fields) wanted.push({ target: allowedSigners, after: `${identity.email} ${key.fields}\n` });
  else result.findings.push(finding(allowedSigners, `${allowedSigners} needs an update.`));
  if (await linkOnPath(home, ".gitconfig")) result.findings.push(finding(".gitconfig", `Your ~/.gitconfig is a link, so Fleet left it alone. Add this to its end so Git uses your Fleet identity:\n${"[include]\n\tpath = ~/" + fleetGitconfig}`, "human"));
  else {
    const current = await readState(home, ".gitconfig");
    wanted.push({ target: ".gitconfig", before: current, after: withInclude(current) });
  }
  const writes: Write[] = [];
  for (const write of wanted) {
    const before = write.target === ".gitconfig" ? write.before : await readState(home, write.target);
    if (before !== write.after) writes.push({ target: write.target, before, after: write.after });
  }
  if (dryRun) result.findings.push(...writes.map((write) => finding(write.target, `${write.target} needs an update.`)));
  else if (writes.length) {
    await writeWithBackups(home, writes);
    result.actions.push(...writes.map((write) => ({ target: write.target, operation: write.before === undefined ? ("create" as const) : ("replace" as const) })));
  }
  for (const type of signer.register) {
    const listed = await registeredKeys(run, type);
    if ("error" in listed) {
      result.findings.push(finding(type, `Could not read your GitHub ${type} keys (${listed.error}). Run gh auth refresh -h github.com -s admin:public_key,admin:ssh_signing_key, then fleet apply.`, "human"));
      continue;
    }
    if (key.fields && listed.includes(key.fields)) continue;
    if (dryRun || !key.fields) {
      result.findings.push(finding(type, `Your Fleet key needs to be registered on GitHub for ${type}.`));
      continue;
    }
    const failed = await registerKey(run, inside(home, signer.publicKey), type, `Fleet ${context.host}`);
    if (failed) result.findings.push(finding(type, `Could not register your Fleet key on GitHub for ${type} (${failed}). Run gh auth refresh -h github.com -s admin:public_key,admin:ssh_signing_key, then fleet apply.`, "human"));
    else result.actions.push({ target: `GitHub ${type} key`, operation: "create", reason: `Fleet ${context.host}` });
  }
}

type Key = { fields?: string; write?: Write };

async function agentHolds(run: CommandRunner, fields: string) {
  const listed = await run(["ssh-add", "-L"]);
  return listed.code === 0 && listed.stdout.split("\n").some((line) => keyFields(line) === fields);
}

async function signingKey(signer: Signer, { home, dryRun, run, result, engineRoot, host }: Context): Promise<Key | null> {
  if (signer.name === "coder") {
    const printed = await run(["/bin/sh", coderScript(engineRoot), "public"]);
    const fields = printed.code === 0 ? keyFields(printed.stdout.split("\n")[0]) : undefined;
    if (!fields) return result.findings.push(finding("key", "The Coder agent did not return your Coder Git SSH key, so Fleet kept your Git identity as it is. Run fleet apply again once the workspace has started.")), null;
    return { fields, write: { target: signer.publicKey, after: `${fields}\n` } };
  }
  const text = await readState(home, signer.publicKey);
  if (signer.name === "1password") {
    if (text === undefined) return result.findings.push(finding("key", `Save the public key of your 1Password SSH key to ~/${signer.publicKey}, then run fleet apply.`, "human")), null;
    const fields = keyFields(text);
    if (!fields) return result.findings.push(finding("key", `~/${signer.publicKey} must hold one SSH public key. Fleet never reads private keys.`, "human")), null;
    return { fields };
  }
  if (text !== undefined) {
    const fields = keyFields(text);
    if (!fields) return result.findings.push(finding("key", `~/${signer.publicKey} is not an SSH public key. Move it away, then run fleet apply to make a new Fleet key.`, "human")), null;
    const derived = await run(["ssh-keygen", "-y", "-P", "", "-f", inside(home, sshKeyTarget)]);
    const signs = (derived.code === 0 && keyFields(derived.stdout.split("\n")[0]) === fields) || (await agentHolds(run, fields));
    if (!signs) return result.findings.push(finding("key", `~/${sshKeyTarget} cannot sign for ~/${signer.publicKey}: the private key is missing, locked and not in your SSH agent, or belongs to another key. Move both files away, then run fleet apply to make a new Fleet key.`, "human")), null;
    return { fields };
  }
  if (existsSync(inside(home, sshKeyTarget))) return result.findings.push(finding("key", `~/${sshKeyTarget} has no public key next to it. Run ssh-keygen -y -f ~/${sshKeyTarget} > ~/${signer.publicKey}, then fleet apply.`, "human")), null;
  if (dryRun) return result.findings.push(finding("key", `Fleet needs to make your SSH key at ~/${sshKeyTarget}.`)), {};
  if (await linkOnPath(home, sshKeyTarget)) return result.findings.push(finding("key", `Fleet makes your SSH key at ~/${sshKeyTarget}, but a folder on that path is a link. Make ~/.ssh a plain folder, then run fleet apply.`, "human")), null;
  await mkdir(inside(home, ".ssh"), { recursive: true, mode: 0o700 });
  const made = await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `fleet ${host}`, "-f", inside(home, sshKeyTarget)]);
  const fields = made.code === 0 ? keyFields(await readState(home, signer.publicKey)) : undefined;
  if (!fields) return result.findings.push(finding("key", `ssh-keygen could not make ~/${sshKeyTarget} (exit ${made.code}).`, "human")), null;
  result.actions.push({ target: sshKeyTarget, operation: "create" });
  return { fields };
}
