import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { loadPacks } from "./pack/manifest.ts";
import { cachedSource, fetchSource } from "./pack/sources.ts";
import type { AvailableSource, FetchedSource, LoadedPack, MachineFile, PackCode, Plan, Report } from "./pack/types.ts";
import { loadMachine, loadProfile, saveMachine, thisMachine } from "./profile/profile.ts";
import { engineAdapters } from "./adapters/index.ts";
import { apply, check, type Adapter, type Runner } from "./reconciler/apply.ts";
import { resolve } from "./reconciler/resolve.ts";
import { readNotice, update } from "./update.ts";
import { setup, type SetupOptions } from "./setup/setup.ts";
import { ttyTerminal, type Terminal } from "./setup/terminal.ts";
import { FlagError } from "./setup/flags.ts";
import type { ChangeContext } from "./commands/change.ts";
import { packsCommand } from "./commands/packs.ts";
import { setCommand, settingsCommand } from "./commands/settings.ts";
import { devboxCommand } from "./commands/devbox.ts";
import { realMachine } from "./setup/commands.ts";
import { packContext, type Clock } from "./runner/context.ts";

/** env: the environment that tells a Coder workspace apart; tests pass their own. */
export type CliOptions = { home: string; engineRoot: string; platform: NodeJS.Platform; env?: Record<string, string | undefined>; print: (line: string) => void; run?: Runner; terminal?: Terminal; apply?: (profileDir: string) => Promise<number>; setup?: Pick<SetupOptions, "machine" | "fetchSource" | "doctor" | "env" | "timeZone">; clock?: Clock; adapters?: () => Adapter[] };

const usage = `Fleet: one setup for T3 Code, agents, and your workflows

  fleet setup [--preset <id>] [--add <pack>]... [--remove <pack>]...
              [--workflows <id=on|off,...>] [--set <pack.key=value>]...
              [--plan <claude|codex|both>] [--non-interactive]
                     Answer a few questions and set up this machine
  fleet apply [--profile <dir>] [--adopt <path>]... [--dry-run]
                     Put your profile's packs onto this machine
  fleet doctor [--profile <dir>]
                     Check this machine against your profile without changing it
  fleet update       Move the engine and your profile forward, then apply
  fleet packs [--add <pack>]... [--remove <pack>]... [--workflows <id=on|off,...>] [--set <pack.key=value>]...
                     List your packs, or turn packs and workflows on and off
  fleet settings     List the settings of your packs
  fleet set [--set] <pack.key=value>...
                     Change settings
  fleet devbox [add <ssh host>]
                     List your devboxes, or make an SSH host one
  fleet run <pack>/<id>
                     Run a pack's service, or test one of its checks
  fleet <command>    Run a command that one of your packs ships`;

const changes = { packs: packsCommand, settings: settingsCommand, set: setCommand };


export async function main(argv: string[], options: CliOptions): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") return options.print(usage), 0;
  try {
    if (command === "apply" || command === "doctor") return await reconcile(command, rest, options);
    if (command === "update") return await runUpdate(options);
    if (command in changes) return await change(command as keyof typeof changes, rest, options);
    if (command === "devbox") return await devbox(rest, options);
    if (command === "run") return await runItem(rest, options);
    if (command === "setup") return await setup(rest, { home: options.home, engineRoot: options.engineRoot, platform: options.platform, ...(options.env ? { env: options.env } : {}), terminal: options.terminal ?? { ...ttyTerminal(), print: options.print }, apply: (dir) => applyProfile(dir, options), doctor: (dir) => reconcile("doctor", ["--profile", dir], options), ...options.setup });
    return await runPackCommand(command, rest, options);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    options.print(`fleet: ${error.message}`);
    return 1;
  }
}

async function reconcile(command: "apply" | "doctor", args: string[], options: CliOptions) {
  const flags = parseFlags(args);
  const doctor = command === "doctor";
  const preview = doctor || flags.dryRun;
  const { plan } = await loadPlan(options, flags.profile, { fetch: !preview, remember: !preview });
  const adapters = (options.adapters ?? engineAdapters)();
  const report = doctor ? await check(plan, { home: options.home, adapters, run: options.run }) : await apply(plan, { home: options.home, adopt: flags.adopt, dryRun: flags.dryRun, adapters, run: options.run });
  const notice = doctor ? await readNotice(options.home) : undefined;
  if (notice) report.findings.push({ id: "update:major", pack: "engine", say: notice });
  printReport(report, command, options.print, flags.dryRun);
  return report.ok ? 0 : 1;
}

async function devbox(args: string[], options: CliOptions) {
  const { plan } = await loadPlan(options, undefined, { fetch: false, remember: false });
  const terminal = options.terminal ?? { ...ttyTerminal(), print: options.print };
  try {
    return await devboxCommand(args, { home: options.home, terminal, machine: { ...realMachine, ...options.setup?.machine }, machineFile: plan.machine, plan });
  } catch (error) {
    if (!(error instanceof FlagError)) throw error;
    options.print(`fleet devbox: ${error.message}`);
    return 2;
  }
}

function applyProfile(dir: string, options: CliOptions) {
  return options.apply ? options.apply(dir) : reconcile("apply", ["--profile", dir], options);
}

async function change(command: keyof typeof changes, args: string[], options: CliOptions) {
  const { plan, sources } = await loadPlan(options, undefined, { fetch: false, remember: false });
  const profileDir = plan.machine.profileDir!;
  const context: ChangeContext = {
    profileDir,
    profile: await loadProfile(profileDir),
    plan,
    packs: sources.flatMap((source) => ("error" in source ? [] : source.packs)),
    print: options.print,
    apply: () => applyProfile(profileDir, options),
  };
  try {
    return await changes[command](args, context);
  } catch (error) {
    if (!(error instanceof FlagError)) throw error;
    options.print(`fleet ${command}: ${error.message}`);
    return 2;
  }
}

async function runUpdate(options: CliOptions) {
  const machine = await loadMachine(options.home);
  if (!machine?.profileDir) throw new Error("no profile on this machine. Run get.sh, or fleet apply --profile <dir>.");
  const profile = await loadProfile(machine.profileDir);
  return update({
    home: options.home,
    engineDir: options.engineRoot,
    profileDir: machine.profileDir,
    engine: profile.engine,
    print: options.print,
    runApply: () => Bun.spawn(["sh", join(options.engineRoot, "fleet"), "apply"], { stdio: ["inherit", "inherit", "inherit"], env: { ...Bun.env, HOME: options.home } }).exited,
  });
}

async function runPackCommand(name: string, args: string[], options: CliOptions) {
  const { plan, sources } = await loadPlan(options, undefined, { fetch: false, remember: false });
  const command = plan.commands[name];
  if (!command) {
    const owner = sources.flatMap((source) => ("error" in source ? [] : source.packs)).find((pack) => existsSync(join(pack.dir, "commands", `${name}.ts`)));
    options.print(owner ? `fleet ${name} comes from the ${owner.manifest.title ?? owner.manifest.name} pack, which is off. Turn it on with fleet packs.` : `fleet: unknown command ${name}\n\n${usage}`);
    return 2;
  }
  const code = loadedPack(sources, command.pack)?.code;
  const run = code?.commands[name];
  const exit = run ? await inPack(plan, command.pack, code!, options, (ctx) => run(args, ctx)) : await spawnPackCommand(command.path, args, plan, options);
  const repairs = plan.human.some((step) => step.pack === command.pack && step.command === ["fleet", name, ...args].join(" "));
  return exit === 0 && repairs ? applyProfile(plan.machine.profileDir!, options) : exit;
}

async function spawnPackCommand(path: string, args: string[], plan: Plan, options: CliOptions) {
  const child = Bun.spawn(["bun", path, ...args], { stdio: ["inherit", "inherit", "inherit"], env: { ...Bun.env, ...packEnvironment(plan, options) } });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forward).on("SIGTERM", forward);
  try { return await child.exited; }
  finally { process.off("SIGINT", forward).off("SIGTERM", forward); }
}

async function runItem(args: string[], options: CliOptions) {
  const [item = "", ...extra] = args;
  const [pack = "", id = ""] = item.split("/");
  if (!pack || !id || extra.length) return options.print("Usage: fleet run <pack>/<id>"), 2;
  const { plan, sources } = await loadPlan(options, undefined, { fetch: false, remember: false });
  const code = plan.packs.some((entry) => entry.name === pack && entry.available) ? loadedPack(sources, pack)?.code : undefined;
  const service = code?.services[id];
  const check = code?.checks[id];
  if (!service && !check) return options.print(`fleet run: your packs have no service or check ${item}`), 2;
  return inPack(plan, pack, code!, options, async (ctx) => (service ? (await service(ctx), 0) : (await check!(ctx)) ? 0 : 1));
}

function loadedPack(sources: FetchedSource[], name: string): LoadedPack | undefined {
  return sources.flatMap((source) => ("error" in source ? [] : source.packs)).find((pack) => pack.manifest.name === name);
}

async function inPack(plan: Plan, pack: string, code: PackCode, options: CliOptions, work: (ctx: Awaited<ReturnType<typeof packContext>>) => Promise<number>) {
  const clock = options.clock ?? { now: Date.now, sleep: Bun.sleep };
  const ctx = await packContext({ home: options.home, plan, pack, code, print: options.print, clock });
  const environment = packEnvironment(plan, options);
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const assign = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  };
  assign(environment);
  try { return await work(ctx); }
  finally { assign(saved); }
}

function packEnvironment(plan: Plan, options: CliOptions): Record<string, string | undefined> {
  return { HOME: options.home, FLEET_ENGINE_DIR: options.engineRoot, FLEET_PROFILE_DIR: plan.machine.profileDir, FLEET_SETTINGS: JSON.stringify(plan.settings), FLEET_MODELS: JSON.stringify(plan.models), FLEET_HANDLERS: JSON.stringify(handlerPaths(plan)) };
}

function handlerPaths(plan: Plan) {
  return Object.fromEntries(Object.entries(plan.handlers).map(([seam, handler]) => [seam, handler.path]));
}

async function loadPlan(options: CliOptions, profileFlag: string | undefined, mode: { fetch: boolean; remember: boolean }): Promise<{ plan: Plan; sources: FetchedSource[] }> {
  const saved = await loadMachine(options.home);
  const profileDir = profileFlag ? resolvePath(profileFlag) : saved?.profileDir;
  if (!profileDir) throw new Error("no profile on this machine. Run get.sh, or pass --profile <dir>.");
  const machine: MachineFile = { ...thisMachine(saved, options.platform, options.env ?? {}), profileDir };
  const profile = await loadProfile(profileDir);
  const cache = join(options.home, ".local", "share", "fleet", "sources");
  const engine: AvailableSource = { ref: { name: "engine", repo: profile.engine.repo, ref: profile.engine.ref }, dir: options.engineRoot, packs: await loadPacks(options.engineRoot) };
  const sources = [engine, ...(await Promise.all(profile.sources.map((ref) => (mode.fetch ? fetchSource(ref, cache) : cachedSource(ref, cache)))))];
  const plan = resolve(profile, machine, sources);
  const changed = saved?.profileDir !== profileDir || saved.role !== machine.role || saved.coder !== machine.coder;
  if (mode.remember && changed) await saveMachine(options.home, machine);
  return { plan, sources };
}

function parseFlags(args: string[]) {
  const flags: { profile?: string; adopt: string[]; dryRun: boolean } = { adopt: [], dryRun: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--profile") flags.profile = value();
    else if (arg === "--adopt") flags.adopt.push(value());
    else if (arg === "--dry-run") flags.dryRun = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return flags;
}

function printReport(report: Report, command: string, print: (line: string) => void, dryRun = false) {
  const changes = report.actions.filter((action) => action.operation !== "keep" && action.operation !== "conflict");
  if (command === "apply") for (const action of changes) print(`${action.operation} ${action.target}`);
  for (const finding of report.findings) print(`${finding.repair === "human" ? "To do" : finding.repair ? "Fix" : "Note"}: ${finding.say}`);
  if (command === "doctor") print(report.ok ? "Everything matches your profile." : "Run fleet apply to fix what Fleet can fix.");
  else if (dryRun) print(report.ok ? `Preview: ${changes.length} change${changes.length === 1 ? "" : "s"} to apply. Nothing was written.` : "Preview: Fleet could not apply your profile. Nothing was written.");
  else print(report.ok ? `Applied ${changes.length} change${changes.length === 1 ? "" : "s"}.` : "Fleet could not apply your profile.");
}


if (import.meta.main) {
  const engineRoot = resolvePath(import.meta.dir, "..");
  if (Bun.argv[2] === "setup") {
    process.on("SIGINT", () => {
      console.log("\nStopped. Run fleet setup again to pick up where it stopped.");
      process.exit(130);
    });
  }
  const code = await main(Bun.argv.slice(2), { home: Bun.env.HOME ?? homedir(), engineRoot, platform: process.platform, env: Bun.env, print: (line) => console.log(line) });
  process.exit(code);
}
