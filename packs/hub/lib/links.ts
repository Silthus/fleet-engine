import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tryLockBox } from "./box-lock.ts";
import { boxPrefix, slugFor, type Coder, type Result } from "./coder.ts";
import { proxyPort, relayPortOf } from "./run.ts";
import { quote, remoteFleet, type Machine, type PeerLinkInput, type PeerMachine } from "./machine.ts";
import { GatewayClientError, gatewayPort, localGatewayUrl, readGatewayClient, writePrivateFile, type GatewaySettings } from "./mcphub/client.ts";
import { isBoxName } from "./names.ts";
import { poolFile, recorded } from "./pool.ts";

export type BoxCoder = Pick<Coder, "binary" | "env" | "boxes" | "ssh" | "sshAfterStartup" | "remove" | "stop" | "extend" | "start" | "create" | "run">;
type Link = { environmentId: string; port: number };
export type Linker = Pick<PeerMachine, "home" | "self" | "run" | "now" | "sleep" | "freePort" | "environmentId" | "linkEnvironment" | "say">;
type Target = { name: string; record: string; unit: string; forward(port: number): Promise<void>; onTarget(command: string): Promise<Result> };

export const t3Port = 3773;
const answerLimitMs = 60_000;
export const claudeTokenPath = ".config/fleet/box-claude-token";
export const boxMarkerPath = ".config/fleet/box-marker";
const gatewayClientPath = ".config/fleet/mcphub.client.json";
const proxyKeyPath = ".config/fleet/cli-proxy.key";

export const t3Of = (here: Pick<Machine, "home">) => join(here.home, ".local/bin/t3");
export const linkFile = (here: Pick<Machine, "home">, box: string) => join(here.home, ".config/fleet/boxes", `${box}.json`);
export const unitOf = (box: string, purpose: "hub" | "t3") => `fleet-box-${box}-${purpose}`;
export const pairCommand = (here: Pick<Machine, "self">) => `~/.local/bin/t3 pair --ttl 5m --label ${here.self} | sed -n 's/^Token: //p'`;

export const boxNameFor = (name: string) => `${boxPrefix}${slugFor(name.startsWith(boxPrefix) ? name.slice(boxPrefix.length) : name)}`;

export function assertBox(name: string): void {
  if (!isBoxName(name)) throw new Error(`${name} is not a box. Only box-* workspaces can be linked or released.`);
}

export async function writeOnBox(coder: Pick<Coder, "ssh">, box: string, path: string, content: string): Promise<void> {
  const install = `umask 077 && mkdir -p ~/${dirname(path)} && t=$(mktemp ~/${path}.XXXXXX) && cat > "$t" && mv -f "$t" ~/${path}`;
  const written = await coder.ssh(box, install, content);
  if (written.code !== 0) throw new Error(`Cannot write ~/${path} on ${box}: ${written.stderr.trim()}`);
}

export const gatewayOf = (here: Machine): GatewaySettings => ({ relayPort: here.settings.relayPort, ...(here.settings.httpsHost ? { httpsHost: here.settings.httpsHost } : {}) });

async function handOverGateway(coder: Pick<Coder, "ssh">, here: Machine, box: string): Promise<boolean> {
  const gateway = gatewayOf(here);
  let client;
  try {
    client = await readGatewayClient(here.home, gateway);
  } catch (error) {
    if (!(error instanceof GatewayClientError)) throw error;
    return here.say(`skip the MCP gateway key: ${error.message}`), false;
  }
  if (!client) return here.say(`skip ~/${gatewayClientPath}: this machine has none`), false;
  await writeOnBox(coder, box, gatewayClientPath, `${JSON.stringify({ baseUrl: localGatewayUrl, token: client.token })}\n`);
  return true;
}

async function handOverGitHub(coder: Pick<Coder, "ssh">, here: Machine, box: string): Promise<void> {
  const hosts = join(here.home, ".config/gh/hosts.yml");
  if (existsSync(hosts) && readFileSync(hosts, "utf8").includes("oauth_token:")) return await writeOnBox(coder, box, ".config/gh/hosts.yml", readFileSync(hosts, "utf8"));
  const token = await here.run(["gh", "auth", "token"]);
  if (token.code !== 0) return here.say("skip the GitHub CLI login: gh is not logged in here");
  const login = await coder.ssh(box, "gh auth login --with-token -h github.com && gh config set -h github.com git_protocol ssh", token.stdout);
  if (login.code !== 0) throw new Error(`Cannot log in the GitHub CLI on ${box}: ${login.stderr.trim()}`);
}

async function handOverProxy(coder: Pick<Coder, "ssh">, here: Machine, box: string): Promise<void> {
  const key = join(here.home, proxyKeyPath);
  if (!existsSync(key)) return here.say(`skip ~/${proxyKeyPath}: this machine has none`);
  const connected = await coder.ssh(box, `umask 077 && ${remoteFleet("cli-proxy connect")}`, readFileSync(key, "utf8"));
  if (connected.code !== 0) here.say(`${box} keeps its own Claude sign-in: ${(connected.stderr || connected.stdout).trim()}`);
}

export async function handOver(coder: Pick<Coder, "ssh">, here: Machine, box: string): Promise<boolean> {
  const gateway = await handOverGateway(coder, here, box);
  const token = join(here.home, claudeTokenPath);
  if (existsSync(token)) await writeOnBox(coder, box, claudeTokenPath, readFileSync(token, "utf8"));
  else here.say(`skip ~/${claudeTokenPath}: this machine has none`);
  await handOverGitHub(coder, here, box);
  if (here.settings.proxy) await handOverProxy(coder, here, box);
  return gateway;
}

function writeSession(here: Pick<Machine, "home">, env: Coder["env"]): string {
  const path = join(here.home, ".config/fleet/box-coder.env");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const partial = `${path}.${crypto.randomUUID()}.partial`;
  writeFileSync(partial, `CODER_SESSION_TOKEN=${quote(env.CODER_SESSION_TOKEN ?? "")}\nCODER_URL=${quote(env.CODER_URL ?? "")}\n`, { mode: 0o600, flag: "wx" });
  renameSync(partial, path);
  return path;
}

export async function startUnit(coder: Pick<Coder, "binary" | "env">, here: Machine, unit: string, args: string[]): Promise<void> {
  await stopUnit(here, unit);
  const session = writeSession(here, coder.env);
  const script = `. ${quote(session)} && export CODER_SESSION_TOKEN CODER_URL && exec ${[await coder.binary(), ...args].map(quote).join(" ")}`;
  const started = await here.run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "-p", "Restart=always", "-p", "RestartSec=30", "sh", "-c", script]);
  if (started.code !== 0) throw new Error(`Cannot start ${unit}: ${started.stderr.trim()}`);
}

const unitNotLoaded = 5;

export async function stopUnit(here: Pick<Machine, "run">, unit: string): Promise<string | undefined> {
  const stopped = await here.run(["systemctl", "--user", "stop", `${unit}.service`]);
  return stopped.code === 0 || stopped.code === unitNotLoaded ? undefined : (stopped.stderr || stopped.stdout).trim() || `exit ${stopped.code}`;
}

const reverse = (port: number) => ["-R", `${port}:127.0.0.1:${port}`];
export const hubForward = (here: Machine, box: string) => ["ssh", "--disable-autostart", "--wait=no", ...reverse(relayPortOf(here.settings.relayPort, here.settings.proxy)), ...reverse(gatewayPort), ...(here.settings.proxy ? reverse(proxyPort) : []), box, "--", "sleep infinity"];
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

export async function unlink(here: Linker, box: string): Promise<boolean> {
  assertBox(box);
  return forget(here, linkFile(here, box), unitOf(box, "t3"));
}

export function readRecord(path: string): Link | undefined {
  const found = lstatSync(path, { throwIfNoEntry: false });
  if (!found) return undefined;
  if (!found.isFile()) throw new Error(`Keep ${path}: it is not a regular file`);
  const record = (() => { try { return JSON.parse(readFileSync(path, "utf8")) as Partial<Link>; } catch { return {}; } })();
  if (typeof record.environmentId !== "string" || !Number.isInteger(record.port)) throw new Error(`Keep ${path}: Fleet did not write it`);
  return record as Link;
}

export async function forget(here: Linker, record: string, unit: string): Promise<boolean> {
  const recorded = readRecord(record);
  if (recorded) {
    const { environmentId } = recorded;
    const unlinked = await here.run([t3Of(here), "environment", "unlink", environmentId]);
    if (unlinked.code !== 0) {
      here.say(`could not unlink ${environmentId}: ${unlinked.stderr.trim()}`);
      return false;
    }
    rmSync(record);
  }
  await stopUnit(here, unit);
  return true;
}

export async function link(coder: Pick<Coder, "binary" | "env" | "ssh">, here: Machine, box: string): Promise<string> {
  if (!(await unlink(here, box))) throw new Error(`Unlink the earlier link to ${box} first.`);
  const unit = unitOf(box, "t3");
  return linkTarget(here, { name: box, record: linkFile(here, box), unit, forward: (port) => startUnit(coder, here, unit, t3Forward(box, port)), onTarget: (command) => coder.ssh(box, command) });
}

export async function linkTarget(here: Linker, target: Target): Promise<string> {
  const port = here.freePort();
  await target.forward(port);
  try {
    const url = `http://127.0.0.1:${port}`;
    const environmentId = await environmentAt(here, url);
    await pairWith(here, target.name, [url], `Cannot link ${target.name}`, target.onTarget);
    await mkdir(dirname(target.record), { recursive: true, mode: 0o700 });
    await writePrivateFile(target.record, `${JSON.stringify({ environmentId, port } satisfies Link)}\n`);
    here.say(`linked ${target.name} as T3 environment ${environmentId} at ${url}`);
    return environmentId;
  } catch (error) {
    await stopUnit(here, target.unit);
    throw error;
  }
}

export async function pairWith(here: Pick<Linker, "self" | "linkEnvironment">, name: string, urls: string[], failure: string, onTarget: Target["onTarget"]): Promise<void> {
  const issued = await onTarget(pairCommand(here));
  const pairingCode = issued.code === 0 ? issued.stdout.trim() : "";
  if (!pairingCode) throw new Error(`${name} did not issue a pairing code${issued.code === 0 ? "." : `: ${issued.stderr.trim()}`}`);
  const input: PeerLinkInput = { url: urls[0]!, alternateUrls: urls.slice(1), pairingCode, access: "full-access" };
  try { await here.linkEnvironment(input); }
  catch (error) { throw new Error(`${failure}: ${(error as Error).message.replaceAll(pairingCode, "[pairing code]")}`); }
}

export function recordedEnvironment(here: Machine, box: string): string {
  const recorded = readRecord(linkFile(here, box));
  if (!recorded) throw new Error(`${box} has no recorded link.`);
  return recorded.environmentId;
}

function laneHolds(here: Machine, box: string): boolean {
  const entry = recorded(poolFile(here.home))[box];
  return entry?.claim !== undefined && !entry.claiming && !entry.leaving;
}

async function revive(here: Pick<Machine, "run" | "say">, unit: string, start: () => Promise<string>): Promise<boolean> {
  if ((await here.run(["systemctl", "--user", "is-active", "--quiet", `${unit}.service`])).code === 0) return true;
  try {
    here.say(await start());
    return true;
  } catch (error) {
    here.say((error as Error).message);
    return false;
  }
}

export async function reviveLink(here: Pick<Machine, "run" | "say">, record: string, name: string, unit: string, forward: (port: number) => Promise<void>): Promise<boolean> {
  if (!lstatSync(record, { throwIfNoEntry: false })) return true;
  return revive(here, unit, async () => {
    const { port } = readRecord(record)!;
    await forward(port);
    return `restored the T3 forward to ${name} on port ${port}`;
  });
}

export async function restoreForward(coder: Pick<Coder, "binary" | "env">, here: Machine, box: string): Promise<boolean> {
  const hubUnit = unitOf(box, "hub");
  const t3Unit = unitOf(box, "t3");
  const hub = !here.isHub || !laneHolds(here, box) || (await revive(here, hubUnit, async () => (await startUnit(coder, here, hubUnit, hubForward(here, box)), `restored the hub forward to ${box}`)));
  const t3 = await reviveLink(here, linkFile(here, box), box, t3Unit, (port) => startUnit(coder, here, t3Unit, t3Forward(box, port)));
  return hub && t3;
}

function restorable(here: Machine): string[] {
  const directory = join(here.home, ".config/fleet/boxes");
  const linked = existsSync(directory) ? readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -".json".length)) : [];
  const held = here.isHub ? Object.keys(recorded(poolFile(here.home))).filter((box) => laneHolds(here, box)) : [];
  return [...new Set([...linked, ...held])].sort();
}

export async function restoreForwards(coder: Pick<Coder, "binary" | "env">, here: Machine): Promise<number> {
  let failed = 0;
  for (const box of restorable(here)) {
    try {
      const unlock = await tryLockBox(here.home, box);
      if (!unlock) {
        here.say(`${box}: another operation holds it; skipped`);
        continue;
      }
      try {
        if (!(await unlock.during(() => restoreForward(coder, here, box)))) failed = 1;
      } finally {
        unlock();
      }
    } catch (error) {
      failed = 1;
      here.say((error as Error).message);
    }
  }
  return failed;
}
