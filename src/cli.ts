import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { loadPacks } from "./pack/manifest.ts";
import { cachedSource, fetchSource } from "./pack/sources.ts";
import { cannotTell } from "./pack/types.ts";
import type { AvailableSource, CatalogEntry, FetchedSource, Finding, LoadedPack, MachineFile, PackCode, Plan, Report } from "./pack/types.ts";
import { loadMachine, loadProfile, pullProfile, saveMachine, thisMachine } from "./profile/profile.ts";
import { engineAdapters } from "./adapters/index.ts";
import { apply, check, type Adapter, type Issuer, type Runner } from "./reconciler/apply.ts";
import { resolve } from "./reconciler/resolve.ts";
import { undoingPack } from "./reconciler/ledger.ts";
import { readNotice, update } from "./update.ts";
import { setup, type SetupOptions } from "./setup/setup.ts";
import { ttyTerminal, type Terminal } from "./setup/terminal.ts";
import { FlagError } from "./setup/flags.ts";
import type { ChangeContext } from "./commands/change.ts";
import { packsCommand } from "./commands/packs.ts";
import { setCommand, settingsCommand } from "./commands/settings.ts";
import { devboxCommand } from "./commands/devbox.ts";
import { hubCommand } from "./commands/hub.ts";
import { triageCommand } from "./commands/triage.ts";
import { recordSetup } from "./commands/triage-record.ts";
import { realMachine } from "./setup/commands.ts";
import { credentialName, packContext, secretStore, type Clock } from "./runner/context.ts";
import { onHub } from "./hub/ssh.ts";
import { drift } from "./reconciler/drift.ts";
import { spawnRunner, type CommandRunner } from "./adapters/run.ts";
import { become, canBecome, type Become } from "./runner/become.ts";

/** env: the environment that tells a Coder workspace apart; tests pass their own. */
export type CliOptions = { home: string; engineRoot: string; platform: NodeJS.Platform; env?: Record<string, string | undefined>; print: (line: string) => void; fail?: (line: string) => void; run?: Runner; terminal?: Terminal; apply?: (profileDir: string, skip?: string[]) => Promise<number>; setup?: Pick<SetupOptions, "machine" | "fetchSource" | "doctor" | "env" | "timeZone" | "clock">; clock?: Clock; adapters?: () => Adapter[]; hostname?: () => string; stdin?: () => ReadableStream<Uint8Array>; capture?: CommandRunner; become?: Become };

const usage = `Fleet: one setup for T3 Code, agents, and your workflows

  fleet setup [--preset <id>] [--add <pack>]... [--remove <pack>]...
              [--workflows <id=on|off,...>] [--set <pack.key=value>]...
              [--plan <claude|codex|both>] [--non-interactive | --chat]
                     Answer a few questions and set up this machine
  fleet apply [--profile <dir>] [--adopt <path>]... [--adopt-from <name>]... [--skip <pack>/<step>]... [--dry-run]
                     Put your profile's packs onto this machine
  fleet doctor [--profile <dir>]
                     Check this machine against your profile without changing it
  fleet update       Move the engine and your profile forward, then apply
  fleet packs [--add <pack>]... [--remove <pack>]... [--workflows <id=on|off,...>] [--set <pack.key=value>]...
                     List your packs, or turn packs and workflows on and off
  fleet settings     List the settings of your packs
  fleet set [--set] <pack.key=value>...
                     Change settings
  fleet devbox [add|remove <ssh host>]
                     List your devboxes, make an SSH host one, or remove one you replaced
  fleet hub here [<ssh name>]
                     Make this machine the hub of your profile
  fleet hub status   Show this machine's name and the hub
  fleet run <pack>/<id> [--repair]
                     Run a pack's service, test one of its checks, or run its repair
  fleet credential <pack>/<id> <node>
                     On the hub, print a served service's credential for a node
  fleet triage [--note <text>] [--print | --save <file> | --send]
                     Show a report of this machine's setup, then send it to the Fleet maintainer
  fleet <command>    Run a command that one of your packs ships`;

const changes = { packs: packsCommand, settings: settingsCommand, set: setCommand };


export async function main(argv: string[], options: CliOptions): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") return options.print(usage), 0;
  try {
    if (command === "apply" || command === "doctor") return await reconcile(command, rest, options);
    if (command === "update") return await runUpdate(options);
    if (Object.hasOwn(changes, command) || command === "hub") return await change(command as keyof typeof changes | "hub", rest, options);
    if (command === "devbox") return await devbox(rest, options);
    if (command === "run") return await runItem(rest, options);
    if (command === "credential") return await credential(rest, options);
    if (command === "setup") return await runSetup(rest, options);
    if (command === "triage") return await triage(rest, options);
    return await runPackCommand(command, rest, options);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    (options.fail ?? options.print)(`fleet: ${error.message}`);
    return 1;
  }
}

/** Runs fleet setup and records its transcript. A failed step's message names fleet triage. */
async function runSetup(args: string[], options: CliOptions) {
  const record = recordSetup(options.home, options.terminal ?? { ...ttyTerminal(), print: options.print }, args);
  const fail = options.fail ?? options.print;
  const recorded: CliOptions = { ...options, print: (line) => (record.print(line), options.print(line)), fail: (line) => (record.print(line), fail(line)) };
  try {
    return await setup(args, { home: options.home, engineRoot: options.engineRoot, platform: options.platform, ...(options.env ? { env: options.env } : {}), terminal: record.terminal, apply: (dir, skip) => applyProfile(dir, recorded, skip), doctor: (dir) => reconcile("doctor", ["--profile", dir], recorded), ...options.setup });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    record.failed(error.message);
    fail(`fleet: ${error.message}`);
    fail("Stuck? Run fleet triage. It shows a report of this setup that you can send to the Fleet maintainer.");
    return 1;
  }
}

async function triage(args: string[], options: CliOptions) {
  const doctor = async () => {
    const lines: string[] = [];
    const collect = (line: string) => void lines.push(line);
    try {
      await reconcile("doctor", [], { ...options, print: collect, fail: collect });
    } catch (error) {
      collect(`fleet: ${error instanceof Error ? error.message : String(error)}`);
    }
    return lines;
  };
  try {
    return await triageCommand(args, { home: options.home, engineRoot: options.engineRoot, platform: options.platform, terminal: options.terminal ?? { ...ttyTerminal(), print: options.print }, capture: options.capture ?? spawnRunner, hostname: (options.hostname ?? hostname)(), doctor });
  } catch (error) {
    if (!(error instanceof FlagError)) throw error;
    options.print(`fleet triage: ${error.message}`);
    return 2;
  }
}

async function reconcile(command: "apply" | "doctor", args: string[], options: CliOptions) {
  const flags = parseFlags(args);
  const doctor = command === "doctor";
  const preview = doctor || flags.dryRun;
  const { plan, sources } = await loadPlan(options, flags.profile, { fetch: !preview, remember: !preview, inherit: preview });
  const adapters = (options.adapters ?? engineAdapters)();
  const issue: Issuer = (entries, node) => issueCredentials(entries, node, plan, sources, options);
  const report = doctor ? await check(plan, { home: options.home, adapters, run: options.run }) : await apply(plan, { home: options.home, adopt: flags.adopt, adoptFrom: flags.adoptFrom, skip: flags.skip, dryRun: flags.dryRun, adapters, run: options.run, issue, progress: options.print });
  if (doctor) {
    const drifted = await drift(plan, report.humanLeft);
    report.findings.push(...drifted);
    if (drifted.some((finding) => finding.repair)) report.ok = false;
  }
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

function changesProfile(command: keyof typeof changes | "hub", args: string[]) {
  return command === "set" || (command === "packs" && args.length > 0) || (command === "hub" && args[0] === "here");
}

function applyProfile(dir: string, options: CliOptions, skip: string[] = []) {
  return options.apply ? options.apply(dir, skip) : reconcile("apply", ["--profile", dir, ...skip.flatMap((step) => ["--skip", step])], options);
}

async function change(command: keyof typeof changes | "hub", args: string[], options: CliOptions) {
  const { plan, sources } = await loadPlan(options, undefined, { fetch: false, remember: false, pull: changesProfile(command, args) });
  const profileDir = plan.machine.profileDir!;
  const profile = await loadProfile(profileDir);
  const context: ChangeContext = {
    profileDir,
    profile,
    plan,
    preview: (answers) => resolve({ ...profile, dir: profileDir, ...answers }, plan.machine, sources),
    packs: sources.flatMap((source) => ("error" in source ? [] : source.packs)),
    machine: { ...realMachine, ...options.setup?.machine },
    print: options.print,
    apply: () => applyProfile(profileDir, options),
  };
  try {
    return await (command === "hub" ? hubCommand(args, { ...context, home: options.home }) : changes[command](args, context));
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
  const typed = ["fleet", name, ...args];
  const undoing = await undoingPack(options.home, options.env ?? {}, typed);
  if (undoing) return runUndo(name, args, undoing, options);
  const { plan, sources } = await loadPlan(options, undefined, { fetch: false, remember: false, inherit: true });
  const command = plan.commands[name];
  if (!command) {
    const owner = sources.flatMap((source) => ("error" in source ? [] : source.packs)).find((pack) => existsSync(join(pack.dir, "commands", `${name}.ts`)) || Object.hasOwn(pack.code?.commands ?? {}, name));
    options.print(owner ? `fleet ${name} comes from the ${owner.manifest.title ?? owner.manifest.name} pack, which is off. Turn it on with fleet packs.` : `fleet: unknown command ${name}\n\n${usage}`);
    return 2;
  }
  if (command.on === "hub" && !plan.onHub) return runOnHub(name, args, plan, options);
  const workflow = command.workflow ? plan.workflows.find((entry) => entry.id === command.workflow) : undefined;
  if (workflow && !workflow.active) throw new Error(`fleet ${name} belongs to the ${workflow.id} workflow, which ${workflow.reason === "turned off" ? `is off. Turn it on with fleet packs --workflows ${workflow.id}=on.` : `is off on this machine: it ${workflow.reason}.`}`);
  const loaded = loadedPack(sources, command.pack);
  const run = loaded?.code?.commands[name]?.run;
  const repairs = plan.human.some((step) => step.command?.trim().split(/\s+/).join("\n") === typed.join("\n"));
  if (!run && !repairs && options.become) return options.become(["bun", command.path, ...args], { ...Bun.env, ...packEnvironment(plan, options) });
  const exit = run ? await inPack(plan, loaded!, options, (ctx) => run(args, ctx)) : await spawnPackCommand(command.path, args, plan, options);
  return exit === 0 && repairs ? applyProfile(plan.machine.profileDir!, options) : exit;
}

/** Runs the undo, check or prerequisite of a ledger step whose pack is off, with that pack's own command on this machine. When Fleet cannot run it here, it exits cannotTell, so the ledger keeps the step for a later apply. */
async function runUndo(name: string, args: string[], pack: string, options: CliOptions) {
  const cannot = (why: string) => (options.print(`fleet ${name}: cannot run the ${pack} pack's command to undo its step: ${why}`), cannotTell);
  let loaded: Awaited<ReturnType<typeof loadPlan>>;
  try {
    loaded = await loadPlan(options, undefined, { fetch: false, remember: false, inherit: true, withPack: pack });
  } catch (error) {
    return cannot((error as Error).message);
  }
  const { plan, sources } = loaded;
  const command = plan.commands[name];
  const owner = command?.pack === pack ? loadedPack(sources, pack) : undefined;
  if (!command || !owner) return cannot(`the ${pack} pack has no command ${name} here`);
  if (command.on === "hub" && !plan.onHub) return cannot("it runs on the hub");
  const run = owner.code?.commands[name]?.run;
  return run ? await inPack(plan, owner, options, (ctx) => run(args, ctx)) : await spawnPackCommand(command.path, args, plan, options);
}

/** A node of the profile, or a Mac on a profile with a hub, runs a hub command on the hub over the one SSH path, with this terminal. Any other machine is told where it runs. When ssh exits 255, it exits 1, so a caller can fall back to another way. */
async function runOnHub(name: string, args: string[], plan: Plan, options: CliOptions) {
  if (!plan.pullsFromHub) throw new Error(`fleet ${name} runs on the hub${plan.hub ? `, ${plan.hub}` : ""}. Run it there.`);
  const answer = await (options.capture ?? spawnRunner)(onHub(plan.hub!, [name, ...args]), { inherit: true });
  const fail = options.fail ?? options.print;
  for (const line of lines(answer.stdout)) options.print(line);
  for (const line of lines(answer.stderr ?? "")) fail(line);
  if (answer.code !== sshUnreachable) return answer.code;
  fail(`fleet ${name}: ssh to the hub ${plan.hub} exited 255. Either ssh could not reach the hub, or the command failed there with 255.`);
  return 1;
}

const sshUnreachable = 255;

const lines = (text: string) => (text ? text.replace(/\n$/, "").split("\n") : []);

async function spawnPackCommand(path: string, args: string[], plan: Plan, options: CliOptions) {
  let child: { kill(signal: NodeJS.Signals): void } | undefined;
  const forward = (signal: NodeJS.Signals) => child?.kill(signal);
  process.on("SIGINT", forward).on("SIGTERM", forward);
  try {
    const started = Bun.spawn(["bun", path, ...args], { stdio: ["inherit", "inherit", "inherit"], env: { ...Bun.env, ...packEnvironment(plan, options) } });
    child = started;
    return await started.exited;
  } finally {
    process.off("SIGINT", forward).off("SIGTERM", forward);
  }
}

async function runItem(args: string[], options: CliOptions) {
  const [item = "", ...extra] = args;
  const slash = item.indexOf("/");
  const [pack, id] = slash < 0 ? ["", ""] : [item.slice(0, slash), item.slice(slash + 1)];
  const repairing = extra.length === 1 && extra[0] === "--repair";
  if (!pack || !id || (extra.length && !repairing)) return options.print("Usage: fleet run <pack>/<id> [--repair]"), 2;
  const { plan, sources } = await loadPlan(options, undefined, { fetch: false, remember: false, inherit: true });
  const loaded = plan.packs.some((entry) => entry.name === pack && entry.available) ? loadedPack(sources, pack) : undefined;
  const code = loaded?.code;
  const job = plan.jobs.find((entry) => entry.pack === pack && entry.id === id);
  const service = job ? code?.services[id] : undefined;
  const check = plan.human.some((step) => step.pack === pack && step.id === id) ? code?.checks[id] : undefined;
  if (!service && !check) {
    const dropped = plan.dropped.find((entry) => entry.pack === pack && (entry.item === `job ${id}` || entry.item === `human ${id}`));
    return options.print(dropped ? `fleet run: ${item} does not run here: ${dropped.reason}` : `fleet run: your packs have no service or check ${item}`), 2;
  }
  const repair = repairing ? code?.repairs[id] : undefined;
  if (repairing && (!check || !repair)) return options.print(`fleet run: ${item} has no repair that Fleet runs`), 2;
  return inPack(plan, loaded!, options, async (ctx) => {
    if (repair) return await repair(ctx), 0;
    if (!service) return (await check!(ctx)) ? 0 : 1;
    const waits = job?.after ? plan.human.find((step) => step.pack === pack && step.id === job.after) : undefined;
    const ready = async () => !waits || (await code!.checks[waits.id]!(ctx));
    if (!(await ready())) {
      options.print(`fleet run: ${item} waits until ${waits!.id} passes. ${waits!.say}${waits!.command ? ` Run: ${waits!.command}` : ""}`);
      do await ctx.sleep(60_000);
      while (!(await ready()));
    }
    return await service(ctx), 0;
  });
}

/** Fills this machine's credential for each served service in the list: the hub asks the service when its pack's secret store holds none, and a node pulls its own from the hub at every apply. A failed issue's finding copies nothing the service threw, since its error may hold its key. */
async function issueCredentials(entries: CatalogEntry[], node: string, plan: Plan, sources: FetchedSource[], options: CliOptions): Promise<Finding[]> {
  if (plan.pullsFromHub) return pullCredentials(entries, node, plan.hub!, options);
  const findings: Finding[] = [];
  for (const entry of entries) {
    const loaded = loadedPack(sources, entry.pack);
    const issue = loaded?.code?.credentials[entry.id];
    const name = credentialName(entry.id);
    if (!issue) continue;
    const stored = await storedSecret(options.home, entry.pack, name);
    if (stored instanceof Error) {
      findings.push({ id: `credential:${entry.pack}/${entry.id}`, pack: entry.pack, say: stored.message, repair: "human" });
      continue;
    }
    if (stored) continue;
    try {
      await inPack(plan, loaded!, options, async (ctx) => {
        await ctx.secrets.write(name, await issued(issue(ctx, node)));
        return 0;
      });
    } catch {
      const service = `${entry.pack}/${entry.id}`;
      findings.push({ id: `credential:${service}`, pack: entry.pack, say: `Could not issue the credential of ${service}. Run fleet credential ${service} ${node} to see why. Fleet tries again at the next apply.`, repair: "apply" });
    }
  }
  return findings;
}

async function issued(value: Promise<string>) {
  const credential = await value;
  if (!credential) throw new Error("it gave no credential");
  return credential;
}

/** A stored secret that the store refuses, such as one that other users can read, comes back as the refusal, which names the file and never the value. */
const storedSecret = (home: string, pack: string, name: string) => secretStore(home, pack).read(name).catch((error: Error) => error);

const pullLimitMs = 90_000;

/** Asks the hub for this node's credential of each service and stores the answer. Each pull ends at a deadline, so a hub that connects but never answers cannot hold the apply. A failed pull keeps what the store holds, and its finding names the exit code and copies nothing the hub printed, since a service may print its key. */
async function pullCredentials(entries: CatalogEntry[], node: string, hub: string, options: CliOptions): Promise<Finding[]> {
  const capture = options.capture ?? spawnRunner;
  const clock = options.clock ?? { now: Date.now, sleep: Bun.sleep };
  const findings: Finding[] = [];
  for (const entry of entries) {
    const service = `${entry.pack}/${entry.id}`;
    const store = secretStore(options.home, entry.pack);
    const name = credentialName(entry.id);
    const stored = await storedSecret(options.home, entry.pack, name);
    const deadline = new AbortController();
    void clock.sleep(pullLimitMs).then(() => deadline.abort());
    const answer = await capture(onHub(hub, ["credential", service, node]), { signal: deadline.signal });
    const late = deadline.signal.aborted;
    deadline.abort();
    const value = answer.stdout.trim();
    if (answer.code === 0 && value) {
      if (stored !== value) await store.write(name, value);
      continue;
    }
    const reason = late ? `it did not answer within ${pullLimitMs / 1000} seconds` : answer.code === 255 ? `ssh exited 255. Run ssh ${hub} true to see why` : `fleet credential exited ${answer.code} there. Run fleet credential ${service} ${node} on the hub to see why`;
    const kept = stored instanceof Error ? stored.message : stored ? "Kept the one this machine has." : "Fleet tries again at the next apply.";
    findings.push({ id: `credential:${service}`, pack: entry.pack, say: `Could not pull the credential of ${service} from the hub ${hub} (${reason}). ${kept}`, repair: "apply" });
  }
  return findings;
}

/** On the hub: the credential that a served service issues for a node of the profile, printed for that node's pull. */
async function credential(args: string[], options: CliOptions) {
  const [item = "", node, ...extra] = args;
  const slash = item.indexOf("/");
  const [pack, id] = slash < 0 ? ["", ""] : [item.slice(0, slash), item.slice(slash + 1)];
  if (!pack || !id || !node || extra.length) return options.print("Usage: fleet credential <pack>/<id> <node>"), 2;
  const { plan, sources } = await loadPlan(options, undefined, { fetch: false, remember: false });
  if (!plan.onHub) throw new Error(`fleet credential runs on the hub${plan.hub ? `, ${plan.hub}` : ""}.`);
  if (!plan.catalog?.some((entry) => entry.pack === pack && entry.id === id)) throw new Error(`the service catalog has no ${item}: its workflow or plan is off in your profile.`);
  const loaded = loadedPack(sources, pack)!;
  const issue = loaded.code!.credentials[id]!;
  const said = { ...options, print: options.fail ?? (() => {}) };
  return inPack(plan, loaded, said, async (ctx) => (options.print(await issued(issue(ctx, node))), 0));
}

function loadedPack(sources: FetchedSource[], name: string): LoadedPack | undefined {
  return sources.flatMap((source) => ("error" in source ? [] : source.packs)).find((pack) => pack.manifest.name === name);
}

async function inPack(plan: Plan, loaded: LoadedPack, options: CliOptions, work: (ctx: Awaited<ReturnType<typeof packContext>>) => Promise<number>) {
  const clock = options.clock ?? { now: Date.now, sleep: Bun.sleep };
  const ctx = await packContext({ home: options.home, plan, pack: loaded.manifest.name, code: loaded.code!, workflows: loaded.manifest.workflows ?? [], print: options.print, clock, stdin: options.stdin });
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
  return { HOME: options.home, FLEET_ENGINE_DIR: options.engineRoot, FLEET_PROFILE_DIR: plan.machine.profileDir, FLEET_SETTINGS: JSON.stringify(plan.settings), FLEET_MODELS: JSON.stringify(plan.models), FLEET_PLAN: plan.ai, FLEET_HANDLERS: JSON.stringify(handlerPaths(plan)) };
}

function handlerPaths(plan: Plan) {
  return Object.fromEntries(Object.entries(plan.handlers).map(([seam, handler]) => [seam, handler.path]));
}

/** withPack resolves the plan as if the profile also had that pack on, for the undo of one of its steps. */
async function loadPlan(options: CliOptions, profileFlag: string | undefined, mode: { fetch: boolean; remember: boolean; inherit?: boolean; pull?: boolean; withPack?: string }): Promise<{ plan: Plan; sources: FetchedSource[] }> {
  const saved = await loadMachine(options.home);
  const inherited = mode.inherit && !profileFlag ? options.env?.FLEET_PROFILE_DIR : undefined;
  const profileDir = profileFlag ? resolvePath(profileFlag) : inherited ? resolvePath(inherited) : saved?.profileDir;
  if (!profileDir) throw new Error("no profile on this machine. Run get.sh, or pass --profile <dir>.");
  const machine: MachineFile = { ...thisMachine(saved, options.platform, options.env ?? {}, (options.hostname ?? hostname)()), profileDir };
  if (mode.pull) await pullProfile(profileDir);
  const loaded = await loadProfile(profileDir);
  const profile = mode.withPack && !loaded.packs.includes(mode.withPack) ? { ...loaded, packs: [...loaded.packs, mode.withPack] } : loaded;
  const cache = join(options.home, ".local", "share", "fleet", "sources");
  const engine: AvailableSource = { ref: { name: "engine", repo: profile.engine.repo, ref: profile.engine.ref }, dir: options.engineRoot, packs: await loadPacks(options.engineRoot) };
  const sources = [engine, ...(await Promise.all(profile.sources.map((ref) => (mode.fetch ? fetchSource(ref, cache) : cachedSource(ref, cache)))))];
  const plan = resolve(profile, machine, sources);
  const changed = saved?.profileDir !== profileDir || saved.role !== plan.machine.role || saved.coder !== plan.machine.coder || saved.name !== plan.machine.name;
  if (mode.remember && changed) await saveMachine(options.home, plan.machine);
  return { plan, sources };
}

function parseFlags(args: string[]) {
  const flags: { profile?: string; adopt: string[]; adoptFrom: string[]; skip: string[]; dryRun: boolean } = { adopt: [], adoptFrom: [], skip: [], dryRun: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--profile") flags.profile = value();
    else if (arg === "--adopt") flags.adopt.push(value());
    else if (arg === "--adopt-from") flags.adoptFrom.push(value());
    else if (arg === "--skip") flags.skip.push(value());
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
  const code = await main(Bun.argv.slice(2), { home: Bun.env.HOME ?? homedir(), engineRoot, platform: process.platform, env: Bun.env, print: (line) => console.log(line), fail: (line) => console.error(line), ...(canBecome() ? { become } : {}) });
  process.exit(code);
}
