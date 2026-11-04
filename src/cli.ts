import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { loadPacks } from "./pack/manifest.ts";
import { cachedSource, fetchSource } from "./pack/sources.ts";
import type { AvailableSource, FetchedSource, MachineFile, Plan, Report } from "./pack/types.ts";
import { loadMachine, loadProfile, saveMachine } from "./profile/profile.ts";
import { engineAdapters } from "./adapters/index.ts";
import { apply, check } from "./reconciler/apply.ts";
import { engineCommands, resolve } from "./reconciler/resolve.ts";
import { readNotice, update } from "./update.ts";

export type CliOptions = { home: string; engineRoot: string; platform: NodeJS.Platform; print: (line: string) => void };

const usage = `Fleet: one setup for T3 Code, agents, and your workflows

  fleet apply [--profile <dir>] [--adopt <path>]... [--dry-run]
                     Put your profile's packs onto this machine
  fleet doctor [--profile <dir>]
                     Check this machine against your profile without changing it
  fleet update       Move the engine and your profile forward, then apply
  fleet <command>    Run a command that one of your packs ships`;

const later = new Set(engineCommands.filter((name) => !["apply", "doctor", "update"].includes(name)));

export async function main(argv: string[], options: CliOptions): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") return options.print(usage), 0;
  if (later.has(command)) return options.print(`fleet ${command} is not available in this version yet.`), 2;
  try {
    if (command === "apply" || command === "doctor") return await reconcile(command, rest, options);
    if (command === "update") return await runUpdate(options);
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
  const adapters = engineAdapters();
  const report = doctor ? await check(plan, { home: options.home, adapters }) : await apply(plan, { home: options.home, adopt: flags.adopt, dryRun: flags.dryRun, adapters });
  const notice = doctor ? await readNotice(options.home) : undefined;
  if (notice) report.findings.push({ id: "update:major", pack: "engine", say: notice });
  printReport(report, command, options.print, flags.dryRun);
  return report.ok ? 0 : 1;
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
    options.print(owner ? `fleet ${name} comes from the ${owner.manifest.name} pack, which is off. Turn it on with fleet packs.` : `fleet: unknown command ${name}\n\n${usage}`);
    return 2;
  }
  const child = Bun.spawn(["bun", command.path, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...Bun.env, HOME: options.home, FLEET_ENGINE_DIR: options.engineRoot, FLEET_PROFILE_DIR: plan.machine.profileDir },
  });
  return child.exited;
}

async function loadPlan(options: CliOptions, profileFlag: string | undefined, mode: { fetch: boolean; remember: boolean }): Promise<{ plan: Plan; sources: FetchedSource[] }> {
  const saved = await loadMachine(options.home);
  const profileDir = profileFlag ? resolvePath(profileFlag) : saved?.profileDir;
  if (!profileDir) throw new Error("no profile on this machine. Run get.sh, or pass --profile <dir>.");
  const machine: MachineFile = { ...saved, schema: 1, role: saved?.role ?? (options.platform === "darwin" ? "mac" : "linux"), profileDir };
  const profile = await loadProfile(profileDir);
  const cache = join(options.home, ".local", "share", "fleet", "sources");
  const engine: AvailableSource = { ref: { name: "engine", repo: profile.engine.repo, ref: profile.engine.ref }, dir: options.engineRoot, packs: await loadPacks(options.engineRoot) };
  const sources = [engine, ...(await Promise.all(profile.sources.map((ref) => (mode.fetch ? fetchSource(ref, cache) : cachedSource(ref, cache)))))];
  const plan = resolve(profile, machine, sources);
  if (mode.remember && saved?.profileDir !== profileDir) await saveMachine(options.home, machine);
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
  const code = await main(Bun.argv.slice(2), { home: Bun.env.HOME ?? homedir(), engineRoot, platform: process.platform, print: (line) => console.log(line) });
  process.exit(code);
}
