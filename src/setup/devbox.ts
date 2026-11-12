import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { AiPlan, ModelRow } from "../pack/types.ts";
import { restartCommand } from "../adapters/t3/service.ts";
import { canBeDevbox } from "../hub/names.ts";
import { onHub, quote } from "../hub/ssh.ts";
import { loadProfile, pullProfile, saveAnswers, validHost } from "../profile/profile.ts";
import type { ExecResult, Machine } from "./commands.ts";
import { engineRepo } from "./defaults.ts";
import { type HumanContext, humanStep, pollMs, type SignIn } from "./human.ts";
import type { Step, StepOutcome } from "./runner.ts";
import { chatgptSignIn, claudeSignIn, githubSignIn } from "./signins.ts";
import type { Terminal } from "./terminal.ts";

export const skipDevbox = "skip";
const boxProfile = "$HOME/.local/share/fleet/profile";
const boxEngine = "$HOME/.local/share/fleet/engine";

/** The concrete hosts in ~/.ssh/config: Host entries without wildcards or negations. */
export function sshHosts(home: string): string[] {
  const path = join(home, ".ssh", "config");
  if (!existsSync(path)) return [];
  const hosts = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim().match(/^host\s+(.+)$/i)?.[1])
    .filter((names): names is string => Boolean(names))
    .flatMap((names) => names.split(/\s+/))
    .filter((name) => !/[*?!]/.test(name));
  return [...new Set(hosts)];
}


/** The devbox as a Machine: its commands run over SSH, while sleeping and the browser stay on this machine. */
export function overSsh(machine: Machine, host: string): Machine {
  if (!validHost(host)) throw new Error(`${host} is not an SSH host name`);
  const line = (command: string[], scratch = false) => {
    const words = command.map(quote).join(" ");
    const body = scratch ? `d=$(mktemp -d) && cd "$d" && ${words}; s=$?; cd / && rm -rf "$d"; exit $s` : words;
    return `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; ${body}`;
  };
  const batch = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host];
  return {
    exec: (command, options = {}) => machine.exec(["ssh", "-T", ...batch, line(command, options.cwd !== undefined)], { ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.input === undefined ? {} : { input: options.input }) }),
    start: (command) => machine.start(["ssh", "-T", ...batch, line(command)]),
    run: (command, options = {}) => machine.run(["ssh", options.input ? "-t" : "-T", ...batch, line(command)], options),
    sleep: (ms) => machine.sleep(ms),
    openUrl: (url) => machine.openUrl(url),
    has: () => true,
  };
}

export type DevboxContext = {
  terminal: Terminal;
  machine: Machine;
  nonInteractive: boolean;
  /** Waits for browser sign-ins although it asks nothing, as fleet setup --chat does. */
  chat?: boolean;
  /** Counts a wait for the person in the setup timings. */
  waited?(): void;
  plan: AiPlan;
  models: ModelRow[];
  /** The profile's clone URL and the engine ref it pins, so the box runs what this machine runs. */
  profile(): Promise<{ url: string; engineRef: string }>;
};

/** The profile's clone URL as stored, and the engine ref the profile pins. */
export async function profileForBox(machine: Machine, profileDir: string | undefined) {
  if (!profileDir) throw new Error("no profile yet");
  const origin = await machine.exec(["git", "-C", profileDir, "config", "--get", "remote.origin.url"]);
  if (origin.code !== 0) throw new Error(`${profileDir} has no origin to clone on the devbox`);
  const { engine } = await loadProfile(profileDir);
  return { url: origin.output.trim(), engineRef: engine.channel === "track" ? "main" : engine.ref };
}

/** Asks which SSH host is the devbox, or takes it from --devbox. Skipping leaves a plan for this machine only. */
export function devboxQuestion(context: { terminal: Terminal; home: string; flag?: string; nonInteractive: boolean; answer(host: string | undefined): Promise<void> }): Step {
  return {
    id: "devbox",
    title: "Your devbox",
    minutes: 1,
    kind: "question",
    async run(): Promise<StepOutcome> {
      const { terminal } = context;
      const chosen = async (host: string | undefined) => {
        await context.answer(host);
        terminal.print(host ? `  ✓ ${host}` : "  ✓ No devbox for now. Add one later with fleet devbox add <host>.");
      };
      if (context.flag) return chosen(context.flag === skipDevbox ? undefined : context.flag);
      const hosts = sshHosts(context.home).filter(canBeDevbox);
      if (context.nonInteractive || !hosts.length) return chosen(undefined);
      terminal.print("? Which SSH host is your devbox?");
      terminal.print("  Fleet installs itself there over SSH, signs it in, and links it with T3 Code here.");
      hosts.forEach((host, index) => terminal.print(`  ${index + 1}) ${host}`));
      for (;;) {
        const reply = await terminal.ask("Press ↵ to skip, or type a number: ");
        if (reply === "") return chosen(undefined);
        const host = hosts[Number(reply) - 1];
        if (Number.isInteger(Number(reply)) && host) return chosen(host);
      }
    },
  };
}

/** The steps that make an SSH host a devbox: install, sign in, apply the profile, and link T3 Code both ways. */
export function devboxSteps(host: string, context: DevboxContext): Step[] {
  const box = overSsh(context.machine, host);
  const human: HumanContext = { terminal: context.terminal, machine: box, nonInteractive: context.nonInteractive, chat: context.chat, waited: context.waited };
  const on = (signIn: SignIn): SignIn => Object.assign(Object.create(signIn) as SignIn, { id: `devbox:${host}:${signIn.id}`, title: `${signIn.title} on ${host}` });
  const chatgpt = chatgptSignIn(box, context.models);
  return [
    auto(host, "install", `Install Fleet on ${host}`, 4, context.terminal, () => install(box, host, context)),
    ...(host.startsWith(coderPrefix) && context.machine.has("coder") ? [auto(host, "coder", `Sign in to Coder on ${host}`, 1, context.terminal, () => coderOnBox(host, box, context.machine))] : []),
    humanStep(on(githubSignIn(box, async () => {})), human),
    auto(host, "profile", `Apply your profile on ${host}`, 3, context.terminal, () => applyProfile(box, context)),
    ...(context.plan === "codex" ? [] : [claudeOnBox(host, box, context)]),
    ...(context.plan === "claude" ? [] : [humanStep(on(Object.assign(Object.create(chatgpt) as SignIn, { command: ["codex", "login", "--device-auth"] })), human)]),
    humanStep(t3Connect(host, box), human),
    auto(host, "link", `Link T3 Code here and on ${host}`, 1, context.terminal, () => linkBothWays(host, box, context)),
  ];
}

function auto(host: string, id: string, title: string, minutes: number, terminal: Terminal, work: () => Promise<void>): Step {
  return {
    id: `devbox:${host}:${id}`,
    title,
    minutes,
    kind: "auto",
    async run() {
      terminal.print(`▶ ${title}`);
      await work();
      terminal.print(`  ✓ ${title}: done`);
    },
  };
}

async function shown(box: Machine, script: string, failure: string) {
  if ((await box.run(["sh", "-c", script])) !== 0) throw new Error(failure);
}

/** Installs Fleet on the devbox and names it by the SSH host this machine reaches it by, the name the profile lists it by. */
async function install(box: Machine, host: string, context: DevboxContext) {
  const { engineRef } = await context.profile();
  const getSh = `https://raw.githubusercontent.com/${engineRepo}/${engineRef}/get.sh`;
  await nameBox(box, host);
  const download = `installer=$(mktemp) && { curl -fsSL ${quote(getSh)} -o "$installer" && sh "$installer" --ref ${quote(engineRef)} --install-only; s=$?; rm -f "$installer"; exit $s; }`;
  await shown(box, download, "Fleet did not install on the devbox. Fix what it says above, then run fleet setup again.");
}

const roleFolder = `"$HOME/.config/fleet"`;
const roleFile = `"$HOME/.config/fleet/machine.json"`;

export async function nameBox(box: Machine, host: string) {
  const read = await box.exec(["sh", "-c", `[ ! -f ${roleFile} ] || cat ${roleFile}`]);
  if (read.code !== 0) throw new Error(`Fleet could not reach ${host} over SSH: ${read.output.trim()}`);
  const saved = read.stdout.trim() ? roleOf(host, read.stdout) : undefined;
  if (saved?.name === host) return;
  if (saved?.name !== undefined) throw new Error(`${host} already calls itself ${String(saved.name)} in ~/.config/fleet/machine.json. Run fleet devbox add ${String(saved.name)} to keep that name, or set its name there to ${host} and run fleet devbox add ${host} again.`);
  const named = { schema: 1, role: "devbox", ...saved, name: host };
  const written = await box.exec(["sh", "-c", `mkdir -p ${roleFolder} && cat > ${roleFile}`], { input: `${JSON.stringify(named)}\n` });
  if (written.code !== 0) throw new Error(`Fleet could not write the role file on ${host}: ${written.output.trim()}`);
}

function roleOf(host: string, text: string): Record<string, unknown> {
  const unreadable = new Error(`Fleet cannot read ~/.config/fleet/machine.json on ${host}. Fix or remove it, then run fleet devbox add ${host} again.`);
  try {
    const role: unknown = JSON.parse(text);
    if (typeof role !== "object" || role === null || Array.isArray(role)) throw unreadable;
    return role as Record<string, unknown>;
  } catch {
    throw unreadable;
  }
}

const coderPrefix = "coder.";

/** The Coder address in what coder whoami prints: "Coder is running at <address>, You're authenticated as <user> !". */
export function coderAddress(whoami: string): string | undefined {
  const address = whoami.match(/Coder is running at (https?:\/\/[^\s,]+)/)?.[1];
  return address?.replace(/\/+$/, "");
}

type CoderSession = { address: string; userId?: string };

/** Who a machine is signed in to Coder as. A deployment can answer at another address on another network, so its user ID tells two sessions apart, and the address does so only for a Coder CLI too old to print the ID. */
async function coderSession(machine: Machine): Promise<CoderSession | undefined> {
  const json = await machine.exec(["coder", "whoami", "-o", "json"]);
  if (json.code === 0) {
    try {
      const [session] = JSON.parse(json.stdout) as Array<{ url?: unknown; user_id?: unknown }>;
      if (typeof session?.url === "string" && typeof session.user_id === "string" && session.user_id) return { address: session.url.replace(/\/+$/, ""), userId: session.user_id };
    } catch {}
  }
  const text = await machine.exec(["coder", "whoami"]);
  const address = text.code === 0 ? coderAddress(text.output) : undefined;
  return address ? { address } : undefined;
}

const sameCoderUser = (here: CoderSession, box: CoderSession | undefined) => box !== undefined && (here.userId && box.userId ? here.userId === box.userId : here.address === box.address);

/** Signs the workspace in to Coder with a new token from this machine, sent on standard input, then writes its SSH config, so it reaches every coder.<workspace> by name. A workspace already signed in as the same Coder user keeps its session, whatever address it reaches Coder by. */
async function coderOnBox(host: string, box: Machine, here: Machine) {
  const session = await coderSession(here);
  if (!session) throw new Error(`Coder is not signed in on this machine. Run coder login <your Coder address> here, then fleet devbox add ${host} again.`);
  const { address } = session;
  if (!sameCoderUser(session, await coderSession(box))) {
    const token = await here.exec(["coder", "tokens", "create"]);
    if (token.code !== 0 || !token.output.trim()) throw new Error(`Coder made no token for ${host}: ${token.output.trim()}`);
    const cli = `"$HOME/.local/bin/coder"`;
    const download = `command -v coder >/dev/null || { case $(uname -m) in x86_64) a=amd64;; aarch64|arm64) a=arm64;; *) exit 1;; esac; mkdir -p "$HOME/.local/bin" && curl -fsSL ${quote(`${address}/bin/coder-linux-`)}"$a" -o ${cli} && chmod +x ${cli}; }`;
    const login = `IFS= read -r token && CODER_SESSION_TOKEN="$token" coder login --use-token-as-session ${quote(address)}`;
    const signedIn = await box.exec(["sh", "-c", `${download} && ${login}`], { input: `${token.output.trim()}\n` });
    if (signedIn.code !== 0) throw new Error(`Coder did not sign in on ${host}: ${signedIn.output.trim()}`);
  }
  const ssh = await box.exec(["coder", "config-ssh", "--yes"]);
  if (ssh.code !== 0) throw new Error(`coder config-ssh failed on ${host}: ${ssh.output.trim()}`);
}

async function applyProfile(box: Machine, context: DevboxContext) {
  const { url, engineRef } = await context.profile();
  const clone = `[ -d "${boxProfile}/.git" ] || gh repo clone ${quote(url)} "${boxProfile}" -- -q`;
  await shown(box, `${clone} && sh "${boxEngine}/get.sh" --ref ${quote(engineRef)} --profile "${boxProfile}"`, "The devbox could not apply your profile. Fix what it says above, then run fleet setup again.");
}

/** Claude signs in on the box in an SSH terminal: its sign-in asks for a code that the person pastes. */
function claudeOnBox(host: string, box: Machine, context: DevboxContext): Step {
  const signIn = claudeSignIn(box, host);
  const title = `${signIn.title} on ${host}`;
  return {
    id: `devbox:${host}:claude`,
    title,
    minutes: 1,
    kind: "human",
    async run(): Promise<StepOutcome> {
      const { terminal } = context;
      if (await signIn.probe()) return terminal.print(`  ✓ ${title}: already done`);
      if (context.nonInteractive) return "unanswered";
      context.waited?.();
      terminal.print(`▶ ${title}  (step needs you, about 1 min)`);
      terminal.print("  Open the link it prints, sign in, then paste the code back here.");
      terminal.print(`  $ ssh -t ${host} claude auth login`);
      terminal.release?.();
      await box.run(["claude", "auth", "login"], { input: true });
      if (!(await signIn.probe())) throw new Error(`Claude is not signed in on ${host} yet. Run fleet setup again to try once more.`);
      terminal.print(`  ✓ ${title}: done`);
    },
  };
}

/** T3 Connect on the box: t3 up signs in, installs the relay client, and restarts the service so the link takes effect. */
function t3Connect(host: string, box: Machine): SignIn {
  return {
    id: `devbox:${host}:t3`,
    title: `Link T3 Connect on ${host}`,
    minutes: 1,
    why: "T3 Code on your other devices reaches the devbox through T3 Connect.",
    command: ["t3", "up", "--connect", "--yes", "--headless"],
    probe: async () => (await linkedStatus(box)) !== undefined,
  };
}

/** Where other machines reach this one through T3 Connect, once it is linked: its own tunnel, never the shared relay. */
async function connectAddress(machine: Machine): Promise<string | undefined> {
  const state = await linkedStatus(machine);
  if (!state) return undefined;
  const tunnel = hostnameOf(state.tunnelHostname) ?? (await tunnelFromServer(machine));
  return tunnel && `https://${tunnel}`;
}

async function linkedStatus(machine: Machine) {
  const state = parsed<{ authenticated?: unknown; linked?: unknown; tunnelHostname?: unknown }>(await machine.exec(["t3", "connect", "status", "--json"]));
  return state?.authenticated === true && state.linked === true ? state : undefined;
}

/** Waits a bounded time for a tunnel that is still starting after T3 Connect links. */
async function connectAddressWithin(machine: Machine): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    const address = await connectAddress(machine);
    if (address || attempt === tunnelStartPolls) return address;
    await machine.sleep(pollMs);
  }
}

const tunnelStartPolls = 15;

/** For T3 CLIs that do not print the tunnel hostname yet: asks the live T3 server on that machine with a short read-only session, and revokes the session after. */
async function tunnelFromServer(machine: Machine): Promise<string | undefined> {
  const origin = await liveServerOrigin(machine);
  if (!origin) return undefined;
  const session = parsed<{ sessionId?: unknown; token?: unknown }>(await machine.exec(["t3", "auth", "session", "issue", "--json", "--ttl", "5m", "--label", "fleet", "--subject", "fleet", "--scope", "relay:read"]));
  if (typeof session?.sessionId !== "string" || typeof session.token !== "string") return undefined;
  try {
    const headers = `authorization: Bearer ${session.token}\nx-t3-orchestration-protocol: 2\n`;
    const linkState = parsed<{ tunnelHostname?: unknown }>(await machine.exec(["curl", "-q", "--noproxy", "*", "-fsS", "--max-time", "15", "-H", "@-", `${origin}/api/connect/link-state`], { input: headers }));
    return hostnameOf(linkState?.tunnelHostname);
  } finally {
    await machine.exec(["t3", "auth", "session", "revoke", session.sessionId]);
  }
}

function parsed<T>(result: ExecResult): T | undefined {
  if (result.code !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as T;
  } catch {
    return undefined;
  }
}

/** The T3 server's own record of where it listens, read from the same base directory the t3 commands here use (a T3CODE_HOME that T3 would trim, expand, or resolve is refused), trusted only at a numeric loopback address and while its process runs: the record T3's own CLI sends its relay sessions to. A dev server keeps its record elsewhere, so Fleet does not guess it. */
async function liveServerOrigin(machine: Machine): Promise<string | undefined> {
  const runtime = parsed<{ origin?: unknown; pid?: unknown }>(await machine.exec(["sh", "-c", runtimeRecord]));
  const url = loopbackUrl(runtime?.origin);
  const pid = runtime?.pid;
  if (!url || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  return (await machine.exec(["sh", "-c", `kill -0 ${pid}`])).code === 0 ? url.origin : undefined;
}

async function tunnelLimitReached(machine: Machine) {
  const log = await machine.exec(["sh", "-c", recentServiceLog]);
  if (log.code !== 0) return undefined;
  const sinceStart = log.stdout.slice(log.stdout.lastIndexOf(serverStarted) + 1);
  return sinceStart.match(tunnelLimit)?.at(-1);
}

const serverStarted = "Listening on http";

const tunnelLimit = /Relay managed tunnel limit reached: this account allows at most \d+ tunnels?/g;

export const t3HomeGuard = `case "$T3CODE_HOME" in *[![:graph:]]* | [!/]* | */../* | */..) exit 1 ;; esac;`;

const runtimeRecord = `${t3HomeGuard} [ -z "$VITE_DEV_SERVER_URL" ] && cat "\${T3CODE_HOME:-$HOME/.t3}/userdata/server-runtime.json"`;

const recentServiceLog = `${t3HomeGuard} tail -c 2000000 "\${T3CODE_HOME:-$HOME/.t3}/userdata/logs/boot-service.log"`;

function loopbackUrl(value: unknown) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

const dnsName = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const hostnameOf = (value: unknown) => (typeof value === "string" && dnsName.test(value) ? value : undefined);

/** Reads `t3 pair` output: where the environment answers, and the one-time code. */
export function pairing(output: string): { url: string; code: string } | undefined {
  const url = output.match(/^Pairing URL: (\S+)/m)?.[1];
  const code = output.match(/^Token: (\S+)/m)?.[1];
  if (!url || !code) return undefined;
  try {
    return { url: new URL(url).origin, code };
  } catch {
    return undefined;
  }
}

/** This machine links the devbox through its T3 Connect address; the devbox links back only when T3 Connect is on here too. */
async function linkBothWays(host: string, box: Machine, context: DevboxContext) {
  const here = hostname();
  const link = async (from: Machine, fromName: string, address: string, to: Machine, toName: string) => {
    const paired = await from.exec(["t3", "pair", "--ttl", "5m", "--label", toName]);
    const found = paired.code === 0 ? pairing(paired.output) : undefined;
    if (!found) throw new Error(`${fromName} did not give a pairing code. Check that T3 Code runs there, then run fleet setup again.`);
    const linked = await to.exec(["t3", "environment", "link", address, "--pairing-code", found.code, "--access", "full-access"]);
    if (linked.code !== 0) throw new Error(`could not link ${fromName} from ${toName}: ${linked.output.trim().split("\n").at(-1) ?? ""}`);
  };
  const boxAddress = await connectAddressWithin(box);
  const limit = boxAddress ? undefined : await tunnelLimitReached(box);
  if (limit) throw new Error(`${host} has no T3 Connect tunnel: T3 Code there says ${limit}. Free one: run t3 connect logout on a machine that no longer needs T3 Connect, or unlink it in T3 Connect. Then run ${restartCommand} on ${host}, and run fleet setup again.`);
  if (!boxAddress) throw new Error(`${host} has no T3 Connect address yet. Update T3 Code on ${host}, then run fleet setup again.`);
  await link(box, host, boxAddress, context.machine, here);
  const hereAddress = await connectAddress(context.machine);
  if (hereAddress) await link(context.machine, here, hereAddress, box, host);
  else if (await linkedStatus(context.machine)) context.terminal.print(`  · T3 Connect is on here, but Fleet could not find this machine's tunnel address. Update T3 Code here, then run fleet setup again so ${host} links back.`);
  else context.terminal.print(`  · ${host} does not link back to this machine, because T3 Connect is off here. Turn it on with t3 up --connect, and T3 Code on ${host} can pair with this machine.`);
}

export type HubContext = { terminal: Terminal; machine: Machine };

const registerId = (host: string) => `devbox:${host}:register`;
const hubLinkId = (host: string) => `devbox:${host}:hub-link`;
const waitsOnHub = (host: string) => [registerId(host), `devbox:${host}:profile`, hubLinkId(host)];

export const notTakenByHub = (id: string, took: Map<string, boolean>) => [...took].some(([host, taken]) => !taken && waitsOnHub(host).includes(id));

export function hubSteps(host: string, context: HubContext & { profileDir: string | undefined; took: Map<string, boolean> }): { register: Step; link: Step } {
  const hubOf = async () => {
    const hub = context.profileDir ? (await loadProfile(context.profileDir)).hub : undefined;
    return hub && hub !== host ? hub : undefined;
  };
  const register: Step = {
    id: registerId(host),
    title: `List ${host} in your profile`,
    minutes: 1,
    kind: "auto",
    async run() {
      await nameBox(overSsh(context.machine, host), host);
      const listedHub = await listInProfile(context.profileDir, host);
      if (listedHub && listedHub !== host) context.took.set(host, await tellHub(context, listedHub, host));
    },
  };
  const link: Step = {
    id: hubLinkId(host),
    title: `Link ${host} from the hub`,
    minutes: 1,
    kind: "auto",
    async run() {
      const hub = await hubOf();
      if (hub) await linkFromHub(context, hub, host, context.took.get(host) ?? true);
    },
  };
  return { register, link };
}

const hubUpdateLimitMs = 15 * 60_000;
const hubLinkLimitMs = 5 * 60_000;
const sshFailed = 255;

/** Lists the devbox in the profile, so the hub and every node know it, and returns the hub the profile names. It pushes on every run, so a push that failed before reaches the remote now. */
export async function listInProfile(profileDir: string | undefined, host: string): Promise<string | undefined> {
  if (!profileDir) return undefined;
  await pullProfile(profileDir);
  const profile = await loadProfile(profileDir);
  const devboxes = profile.devboxes?.includes(host) ? profile.devboxes : [...(profile.devboxes ?? []), host];
  await saveAnswers(profileDir, { devboxes }, { push: true });
  return profile.hub;
}

/** Has the hub take the new node before the node applies its profile, so the hub serves the node's credentials, and its disk watch and tunnels include it. */
export async function tellHub({ machine, terminal }: HubContext, hub: string, host: string): Promise<boolean> {
  terminal.print(`▶ The hub, ${hub}, takes ${host} with fleet update there. This can take some minutes.`);
  const updated = await machine.exec(onHub(hub, ["update"]), { timeoutMs: hubUpdateLimitMs });
  const reason = updated.output.trim().split("\n").at(-1);
  if (updated.code === 0) terminal.print(`✓ The hub, ${hub}, took ${host}: its disk watch, tunnels and credentials include it now.`);
  else if (updated.code === sshFailed || !reason) terminal.print(`· The hub, ${hub}, did not answer. It takes ${host} at its next fleet update, or run fleet update there now.`);
  else terminal.print(`· The hub, ${hub}, could not update: ${reason} Fix that there and run fleet update there; it takes ${host} then.`);
  return updated.code === 0;
}

export async function linkFromHub({ machine, terminal }: HubContext, hub: string, host: string, hubTook: boolean) {
  const linked = hubTook && (await machine.exec(onHub(hub, ["peers", "link", host]), { timeoutMs: hubLinkLimitMs })).code === 0;
  terminal.print(linked ? `✓ The hub, ${hub}, linked ${host} in T3 Code.` : `· The hub, ${hub}, has not linked ${host} in T3 Code yet. Its daily fleet peers renew links it, or run fleet peers link ${host} there now.`);
}
