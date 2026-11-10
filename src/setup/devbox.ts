import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { AiPlan, ModelRow } from "../pack/types.ts";
import { loadProfile, validHost } from "../profile/profile.ts";
import type { Machine } from "./commands.ts";
import { engineRepo } from "./defaults.ts";
import { type HumanContext, humanStep, type SignIn } from "./human.ts";
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


export function quote(word: string) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
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
    exec: (command, options = {}) => machine.exec(["ssh", "-T", ...batch, line(command, options.cwd !== undefined)], options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
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
      const hosts = sshHosts(context.home);
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
  const human: HumanContext = { terminal: context.terminal, machine: box, nonInteractive: context.nonInteractive };
  const on = (signIn: SignIn): SignIn => Object.assign(Object.create(signIn) as SignIn, { id: `devbox:${host}:${signIn.id}`, title: `${signIn.title} on ${host}` });
  const chatgpt = chatgptSignIn(box, context.models);
  return [
    auto(host, "install", `Install Fleet on ${host}`, 4, context.terminal, () => install(box, context)),
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

async function install(box: Machine, context: DevboxContext) {
  const { engineRef } = await context.profile();
  const getSh = `https://raw.githubusercontent.com/${engineRepo}/${engineRef}/get.sh`;
  const role = `mkdir -p "$HOME/.config/fleet" && { [ -f "$HOME/.config/fleet/machine.json" ] || printf '{"schema":1,"role":"devbox"}\\n' > "$HOME/.config/fleet/machine.json"; }`;
  const download = `installer=$(mktemp) && { curl -fsSL ${quote(getSh)} -o "$installer" && sh "$installer" --ref ${quote(engineRef)} --install-only; s=$?; rm -f "$installer"; exit $s; }`;
  await shown(box, `${role} && ${download}`, "Fleet did not install on the devbox. Fix what it says above, then run fleet setup again.");
}

async function applyProfile(box: Machine, context: DevboxContext) {
  const { url, engineRef } = await context.profile();
  const clone = `[ -d "${boxProfile}/.git" ] || gh repo clone ${quote(url)} "${boxProfile}" -- -q`;
  await shown(box, `${clone} && sh "${boxEngine}/get.sh" --ref ${quote(engineRef)} --profile "${boxProfile}"`, "The devbox could not apply your profile. Fix what it says above, then run fleet setup again.");
}

/** Claude signs in on the box in an SSH terminal: its sign-in asks for a code that the person pastes. */
function claudeOnBox(host: string, box: Machine, context: DevboxContext): Step {
  const signIn = claudeSignIn(box);
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
    probe: async () => (await connectAddress(box)) !== undefined,
  };
}

/** Where other machines reach this one through T3 Connect, once it is linked. */
async function connectAddress(machine: Machine): Promise<string | undefined> {
  const status = await machine.exec(["t3", "connect", "status", "--json"]);
  if (status.code !== 0) return undefined;
  try {
    const state = JSON.parse(status.output) as { authenticated?: unknown; linked?: unknown; relayUrl?: unknown };
    return state.authenticated === true && state.linked === true && typeof state.relayUrl === "string" ? new URL(state.relayUrl).origin : undefined;
  } catch {
    return undefined;
  }
}

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
  const boxAddress = await connectAddress(box);
  if (!boxAddress) throw new Error(`${host} has no T3 Connect address yet. Run fleet setup again once T3 Connect is linked there.`);
  await link(box, host, boxAddress, context.machine, here);
  const hereAddress = await connectAddress(context.machine);
  if (hereAddress) await link(context.machine, here, hereAddress, box, host);
  else context.terminal.print(`  · ${host} does not link back to this machine, because T3 Connect is off here. Turn it on with t3 up --connect, and T3 Code on ${host} can pair with this machine.`);
}
