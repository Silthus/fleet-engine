import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boxPrefix, slugFor, type Coder } from "./coder.ts";
import { quote, type Machine } from "./machine.ts";

export type BoxCoder = Pick<Coder, "binary" | "boxes" | "ssh" | "sshLater" | "sshAfterStartup" | "remove" | "stop" | "extend" | "start" | "create" | "run">;
type Link = { environmentId: string; port: number };

export const t3Port = 3773;
const answerLimitMs = 60_000;
export const claudeTokenPath = ".config/fleet/box-claude-token";
const handedOver = [".config/fleet/mcphub.client.json", claudeTokenPath];

const t3Of = (here: Machine) => join(here.home, ".local/bin/t3");
export const linkFile = (here: Machine, box: string) => join(here.home, ".config/fleet/boxes", `${box}.json`);
export const unitOf = (box: string, purpose: "hub" | "t3") => `fleet-box-${box}-${purpose}`;
export const pairCommand = (here: Machine) => `~/.local/bin/t3 pair --ttl 5m --label ${here.self} | sed -n 's/^Token: //p'`;

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

export function startUnit(coder: Pick<Coder, "binary">, here: Machine, unit: string, args: string[]): void {
  stopUnit(here, unit);
  const session = existsSync(join(here.home, ".config/fleet/coder-session")) ? [".config/fleet/coder-session", ".config/fleet/coder-url"] : [".config/coderv2/session", ".config/coderv2/url"];
  const script = `export CODER_SESSION_TOKEN="$(cat ~/${session[0]})" CODER_URL="$(cat ~/${session[1]})" && exec ${[coder.binary, ...args].map(quote).join(" ")}`;
  const started = here.run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "-p", "Restart=always", "-p", "RestartSec=30", "sh", "-c", script]);
  if (started.code !== 0) throw new Error(`Cannot start ${unit}: ${started.stderr.trim()}`);
}

export function stopUnit(here: Machine, unit: string): void {
  here.run(["systemctl", "--user", "stop", `${unit}.service`]);
}

export const hubForward = (here: Machine, box: string) => ["ssh", "--disable-autostart", "--wait=no", "-R", `${here.settings.relayPort}:127.0.0.1:${here.settings.relayPort}`, box, "--", "sleep infinity"];
const t3Forward = (box: string, port: number) => ["port-forward", "--disable-autostart", box, "--tcp", `${port}:${t3Port}`];

async function environmentAt(here: Machine, url: string): Promise<string> {
  const deadline = here.now() + answerLimitMs;
  while (here.now() < deadline) {
    const environmentId = await here.environmentId(url);
    if (environmentId) return environmentId;
    await here.sleep(1000);
  }
  throw new Error(`T3 did not answer at ${url} within a minute.`);
}

export function unlink(here: Machine, box: string): boolean {
  assertBox(box);
  const record = linkFile(here, box);
  if (existsSync(record)) {
    const { environmentId } = JSON.parse(readFileSync(record, "utf8")) as Link;
    const unlinked = here.run([t3Of(here), "environment", "unlink", environmentId]);
    if (unlinked.code !== 0) {
      here.say(`could not unlink ${environmentId}: ${unlinked.stderr.trim()}`);
      return false;
    }
    rmSync(record);
  }
  stopUnit(here, unitOf(box, "t3"));
  return true;
}

export async function link(coder: Pick<Coder, "binary" | "ssh">, here: Machine, box: string): Promise<string> {
  if (!unlink(here, box)) throw new Error(`Unlink the earlier link to ${box} first.`);
  const unit = unitOf(box, "t3");
  const port = here.freePort();
  startUnit(coder, here, unit, t3Forward(box, port));
  try {
    const url = `http://127.0.0.1:${port}`;
    const environmentId = await environmentAt(here, url);
    const code = coder.ssh(box, pairCommand(here)).stdout.trim();
    if (!code) throw new Error(`${box} did not issue a pairing code.`);
    const linked = here.run([t3Of(here), "environment", "link", url, "--pairing-code", code, "--access", "full-access"]);
    if (linked.code !== 0) throw new Error(`Cannot link ${box}: ${(linked.stderr || linked.stdout).trim()}`);
    const record = linkFile(here, box);
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, `${JSON.stringify({ environmentId, port } satisfies Link)}\n`, { mode: 0o600 });
    here.say(`linked ${box} as T3 environment ${environmentId} at ${url}`);
    return environmentId;
  } catch (error) {
    stopUnit(here, unit);
    throw error;
  }
}

export function recordedEnvironment(here: Machine, box: string): string {
  return (JSON.parse(readFileSync(linkFile(here, box), "utf8")) as Link).environmentId;
}

export function restoreForwards(coder: Pick<Coder, "binary">, here: Machine): number {
  const directory = join(here.home, ".config/fleet/boxes");
  const recorded = existsSync(directory) ? readdirSync(directory).filter((file) => file.endsWith(".json")).sort() : [];
  let failed = 0;
  for (const file of recorded) {
    const box = file.slice(0, -".json".length);
    const unit = unitOf(box, "t3");
    if (here.run(["systemctl", "--user", "is-active", "--quiet", `${unit}.service`]).code === 0) continue;
    try {
      const { port } = JSON.parse(readFileSync(join(directory, file), "utf8")) as Link;
      startUnit(coder, here, unit, t3Forward(box, port));
      here.say(`restored the T3 forward to ${box} on port ${port}`);
    } catch (error) {
      failed = 1;
      here.say((error as Error).message);
    }
  }
  return failed;
}
