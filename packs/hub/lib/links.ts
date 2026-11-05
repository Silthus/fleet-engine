import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { boxPrefix, slugFor, type Coder } from "./coder.ts";
import { quote, type Machine, type PeerLinkInput, type PeerMachine } from "./machine.ts";
import { writePrivateFile } from "./mcphub/client.ts";

export type BoxCoder = Pick<Coder, "binary" | "env" | "boxes" | "ssh" | "sshLater" | "sshAfterStartup" | "remove" | "stop" | "extend" | "start" | "create" | "run">;
type Link = { environmentId: string; port: number };
export type Linker = Pick<PeerMachine, "home" | "self" | "run" | "now" | "sleep" | "freePort" | "environmentId" | "linkEnvironment" | "say">;
type Target = { name: string; record: string; unit: string; forward(port: number): void; onTarget(command: string): { stdout: string } };

export const t3Port = 3773;
const answerLimitMs = 60_000;
export const claudeTokenPath = ".config/fleet/box-claude-token";
const handedOver = [".config/fleet/mcphub.client.json", claudeTokenPath];

export const t3Of = (here: Pick<Machine, "home">) => join(here.home, ".local/bin/t3");
export const linkFile = (here: Pick<Machine, "home">, box: string) => join(here.home, ".config/fleet/boxes", `${box}.json`);
export const unitOf = (box: string, purpose: "hub" | "t3") => `fleet-box-${box}-${purpose}`;
export const pairCommand = (here: Pick<Machine, "self">) => `~/.local/bin/t3 pair --ttl 5m --label ${here.self} | sed -n 's/^Token: //p'`;

export const boxNameFor = (name: string) => `${boxPrefix}${slugFor(name.startsWith(boxPrefix) ? name.slice(boxPrefix.length) : name)}`;

export function assertBox(name: string): void {
  if (!/^box-[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`${name} is not a box. Only box-* workspaces can be linked or released.`);
}

export function writeOnBox(coder: Pick<Coder, "ssh">, box: string, path: string, content: string): void {
  const install = `umask 077 && mkdir -p ~/${dirname(path)} && t=$(mktemp ~/${path}.XXXXXX) && cat > "$t" && mv -f "$t" ~/${path}`;
  const written = coder.ssh(box, install, content);
  if (written.code !== 0) throw new Error(`Cannot write ~/${path} on ${box}: ${written.stderr.trim()}`);
}

export function handOver(coder: Pick<Coder, "ssh">, here: Machine, box: string): void {
  for (const path of handedOver) {
    const source = join(here.home, path);
    if (existsSync(source)) writeOnBox(coder, box, path, readFileSync(source, "utf8"));
    else here.say(`skip ~/${path}: this machine has none`);
  }
  const hosts = join(here.home, ".config/gh/hosts.yml");
  if (existsSync(hosts) && readFileSync(hosts, "utf8").includes("oauth_token:")) return writeOnBox(coder, box, ".config/gh/hosts.yml", readFileSync(hosts, "utf8"));
  const token = here.run(["gh", "auth", "token"]);
  if (token.code !== 0) return here.say("skip the GitHub CLI login: gh is not logged in here");
  const login = coder.ssh(box, "gh auth login --with-token -h github.com && gh config set -h github.com git_protocol ssh", token.stdout);
  if (login.code !== 0) throw new Error(`Cannot log in the GitHub CLI on ${box}: ${login.stderr.trim()}`);
}

function writeSession(here: Pick<Machine, "home">, env: Coder["env"]): string {
  const path = join(here.home, ".config/fleet/box-coder.env");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const partial = `${path}.${crypto.randomUUID()}.partial`;
  writeFileSync(partial, `CODER_SESSION_TOKEN=${quote(env.CODER_SESSION_TOKEN ?? "")}\nCODER_URL=${quote(env.CODER_URL ?? "")}\n`, { mode: 0o600, flag: "wx" });
  renameSync(partial, path);
  return path;
}

export function startUnit(coder: Pick<Coder, "binary" | "env">, here: Machine, unit: string, args: string[]): void {
  stopUnit(here, unit);
  const session = writeSession(here, coder.env);
  const script = `. ${quote(session)} && export CODER_SESSION_TOKEN CODER_URL && exec ${[coder.binary, ...args].map(quote).join(" ")}`;
  const started = here.run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "-p", "Restart=always", "-p", "RestartSec=30", "sh", "-c", script]);
  if (started.code !== 0) throw new Error(`Cannot start ${unit}: ${started.stderr.trim()}`);
}

export function stopUnit(here: Pick<Machine, "run">, unit: string): void {
  here.run(["systemctl", "--user", "stop", `${unit}.service`]);
}

export const hubForward = (here: Machine, box: string) => ["ssh", "--disable-autostart", "--wait=no", "-R", `${here.settings.relayPort}:127.0.0.1:${here.settings.relayPort}`, box, "--", "sleep infinity"];
const t3Forward = (box: string, port: number) => ["port-forward", "--disable-autostart", box, "--tcp", `${port}:${t3Port}`];

async function environmentAt(here: Linker, url: string): Promise<string> {
  const deadline = here.now() + answerLimitMs;
  while (here.now() < deadline) {
    const environmentId = await here.environmentId(url, deadline - here.now());
    if (environmentId) return environmentId;
    if (here.now() < deadline) await here.sleep(Math.min(1000, deadline - here.now()));
  }
  throw new Error(`T3 did not answer at ${url} within a minute.`);
}

export function unlink(here: Linker, box: string): boolean {
  assertBox(box);
  return forget(here, linkFile(here, box), unitOf(box, "t3"));
}

export function forget(here: Linker, record: string, unit: string): boolean {
  if (existsSync(record)) {
    const { environmentId } = JSON.parse(readFileSync(record, "utf8")) as Link;
    const unlinked = here.run([t3Of(here), "environment", "unlink", environmentId]);
    if (unlinked.code !== 0) {
      here.say(`could not unlink ${environmentId}: ${unlinked.stderr.trim()}`);
      return false;
    }
    rmSync(record);
  }
  stopUnit(here, unit);
  return true;
}

export async function link(coder: Pick<Coder, "binary" | "env" | "ssh">, here: Machine, box: string): Promise<string> {
  if (!unlink(here, box)) throw new Error(`Unlink the earlier link to ${box} first.`);
  const unit = unitOf(box, "t3");
  return linkTarget(here, { name: box, record: linkFile(here, box), unit, forward: (port) => startUnit(coder, here, unit, t3Forward(box, port)), onTarget: (command) => coder.ssh(box, command) });
}

export async function linkTarget(here: Linker, target: Target): Promise<string> {
  const port = here.freePort();
  target.forward(port);
  try {
    const url = `http://127.0.0.1:${port}`;
    const environmentId = await environmentAt(here, url);
    await pairWith(here, target.name, [url], `Cannot link ${target.name}`, target.onTarget);
    await mkdir(dirname(target.record), { recursive: true, mode: 0o700 });
    await writePrivateFile(target.record, `${JSON.stringify({ environmentId, port } satisfies Link)}\n`);
    here.say(`linked ${target.name} as T3 environment ${environmentId} at ${url}`);
    return environmentId;
  } catch (error) {
    stopUnit(here, target.unit);
    throw error;
  }
}

export async function pairWith(here: Pick<Linker, "self" | "linkEnvironment">, name: string, urls: string[], failure: string, onTarget: Target["onTarget"]): Promise<void> {
  const pairingCode = onTarget(pairCommand(here)).stdout.trim();
  if (!pairingCode) throw new Error(`${name} did not issue a pairing code.`);
  const input: PeerLinkInput = { url: urls[0]!, alternateUrls: urls.slice(1), pairingCode, access: "full-access" };
  try { await here.linkEnvironment(input); }
  catch (error) { throw new Error(`${failure}: ${(error as Error).message.replaceAll(pairingCode, "[pairing code]")}`); }
}

export function recordedEnvironment(here: Machine, box: string): string {
  return (JSON.parse(readFileSync(linkFile(here, box), "utf8")) as Link).environmentId;
}

export function restoreForwards(coder: Pick<Coder, "binary" | "env">, here: Machine): number {
  return restoreRecorded(here, join(here.home, ".config/fleet/boxes"), (box) => unitOf(box, "t3"), (box, unit, port) => startUnit(coder, here, unit, t3Forward(box, port)));
}

export function restoreRecorded(here: Pick<Machine, "run" | "say">, directory: string, unitFor: (name: string) => string, forward: (name: string, unit: string, port: number) => void): number {
  const recorded = existsSync(directory) ? readdirSync(directory).filter((file) => file.endsWith(".json")).sort() : [];
  let failed = 0;
  for (const file of recorded) {
    const name = file.slice(0, -".json".length);
    const unit = unitFor(name);
    if (here.run(["systemctl", "--user", "is-active", "--quiet", `${unit}.service`]).code === 0) continue;
    try {
      const { port } = JSON.parse(readFileSync(join(directory, file), "utf8")) as Link;
      forward(name, unit, port);
      here.say(`restored the T3 forward to ${name} on port ${port}`);
    } catch (error) {
      failed = 1;
      here.say((error as Error).message);
    }
  }
  return failed;
}
