import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tryLockBox } from "./box-lock.ts";
import { boxPrefix, slugFor, type Coder } from "./coder.ts";
import { quote, type Machine } from "./machine.ts";
import { devboxGatewayUrl, GatewayClientError, gatewayPort, readGatewayClient, type GatewaySettings } from "./mcphub/client.ts";
import { poolFile, recorded } from "./pool.ts";

export type BoxCoder = Pick<Coder, "binary" | "env" | "boxes" | "ssh" | "sshAfterStartup" | "remove" | "stop" | "extend" | "start" | "create" | "run">;
type Link = { environmentId: string; port: number };

export const t3Port = 3773;
const answerLimitMs = 60_000;
export const claudeTokenPath = ".config/fleet/box-claude-token";
const gatewayClientPath = ".config/fleet/mcphub.client.json";

const t3Of = (here: Machine) => join(here.home, ".local/bin/t3");
export const linkFile = (here: Machine, box: string) => join(here.home, ".config/fleet/boxes", `${box}.json`);
export const unitOf = (box: string, purpose: "hub" | "t3") => `fleet-box-${box}-${purpose}`;
export const pairCommand = (here: Machine) => `~/.local/bin/t3 pair --ttl 5m --label ${here.self} | sed -n 's/^Token: //p'`;

export const boxNameFor = (name: string) => `${boxPrefix}${slugFor(name.startsWith(boxPrefix) ? name.slice(boxPrefix.length) : name)}`;

export function assertBox(name: string): void {
  if (!/^box-[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`${name} is not a box. Only box-* workspaces can be linked or released.`);
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
  await writeOnBox(coder, box, gatewayClientPath, `${JSON.stringify({ baseUrl: devboxGatewayUrl(gateway), token: client.token })}\n`);
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

export async function handOver(coder: Pick<Coder, "ssh">, here: Machine, box: string): Promise<boolean> {
  const gateway = await handOverGateway(coder, here, box);
  const token = join(here.home, claudeTokenPath);
  if (existsSync(token)) await writeOnBox(coder, box, claudeTokenPath, readFileSync(token, "utf8"));
  else here.say(`skip ~/${claudeTokenPath}: this machine has none`);
  await handOverGitHub(coder, here, box);
  return gateway;
}

function writeSession(here: Machine, env: Coder["env"]): string {
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

export async function stopUnit(here: Machine, unit: string): Promise<void> {
  await here.run(["systemctl", "--user", "stop", `${unit}.service`]);
}

const reverse = (port: number) => ["-R", `${port}:127.0.0.1:${port}`];
export const hubForward = (here: Machine, box: string) => ["ssh", "--disable-autostart", "--wait=no", ...reverse(here.settings.relayPort), ...(here.settings.httpsHost ? [] : reverse(gatewayPort)), box, "--", "sleep infinity"];
const t3Forward = (box: string, port: number) => ["port-forward", "--disable-autostart", box, "--tcp", `${port}:${t3Port}`];

async function environmentAt(here: Machine, url: string): Promise<string> {
  const deadline = here.now() + answerLimitMs;
  while (here.now() < deadline) {
    const environmentId = await here.environmentId(url, deadline - here.now());
    if (environmentId) return environmentId;
    if (here.now() < deadline) await here.sleep(Math.min(1000, deadline - here.now()));
  }
  throw new Error(`T3 did not answer at ${url} within a minute.`);
}

export async function unlink(here: Machine, box: string): Promise<boolean> {
  assertBox(box);
  const record = linkFile(here, box);
  if (existsSync(record)) {
    const { environmentId } = JSON.parse(readFileSync(record, "utf8")) as Link;
    const unlinked = await here.run([t3Of(here), "environment", "unlink", environmentId]);
    if (unlinked.code !== 0) {
      here.say(`could not unlink ${environmentId}: ${unlinked.stderr.trim()}`);
      return false;
    }
    rmSync(record);
  }
  await stopUnit(here, unitOf(box, "t3"));
  return true;
}

export async function link(coder: Pick<Coder, "binary" | "env" | "ssh">, here: Machine, box: string): Promise<string> {
  if (!(await unlink(here, box))) throw new Error(`Unlink the earlier link to ${box} first.`);
  const unit = unitOf(box, "t3");
  const port = here.freePort();
  await startUnit(coder, here, unit, t3Forward(box, port));
  try {
    const url = `http://127.0.0.1:${port}`;
    const environmentId = await environmentAt(here, url);
    const code = (await coder.ssh(box, pairCommand(here))).stdout.trim();
    if (!code) throw new Error(`${box} did not issue a pairing code.`);
    const linked = await here.run([t3Of(here), "environment", "link", url, "--pairing-code", code, "--access", "full-access"]);
    if (linked.code !== 0) throw new Error(`Cannot link ${box}: ${(linked.stderr || linked.stdout).trim()}`);
    const record = linkFile(here, box);
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, `${JSON.stringify({ environmentId, port } satisfies Link)}\n`, { mode: 0o600 });
    here.say(`linked ${box} as T3 environment ${environmentId} at ${url}`);
    return environmentId;
  } catch (error) {
    await stopUnit(here, unit);
    throw error;
  }
}

export function recordedEnvironment(here: Machine, box: string): string {
  return (JSON.parse(readFileSync(linkFile(here, box), "utf8")) as Link).environmentId;
}

function laneHolds(here: Machine, box: string): boolean {
  const entry = recorded(poolFile(here.home))[box];
  return entry?.claim !== undefined && !entry.claiming && !entry.leaving;
}

async function revive(coder: Pick<Coder, "binary" | "env">, here: Machine, unit: string, forward: () => [string[], string]): Promise<boolean> {
  if ((await here.run(["systemctl", "--user", "is-active", "--quiet", `${unit}.service`])).code === 0) return true;
  try {
    const [args, said] = forward();
    await startUnit(coder, here, unit, args);
    here.say(said);
    return true;
  } catch (error) {
    here.say((error as Error).message);
    return false;
  }
}

export async function restoreForward(coder: Pick<Coder, "binary" | "env">, here: Machine, box: string): Promise<boolean> {
  const record = linkFile(here, box);
  const hub = !here.isHub || !laneHolds(here, box) || (await revive(coder, here, unitOf(box, "hub"), () => [hubForward(here, box), `restored the hub forward to ${box}`]));
  const t3 = !existsSync(record) || (await revive(coder, here, unitOf(box, "t3"), () => {
    const { port } = JSON.parse(readFileSync(record, "utf8")) as Link;
    return [t3Forward(box, port), `restored the T3 forward to ${box} on port ${port}`];
  }));
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
