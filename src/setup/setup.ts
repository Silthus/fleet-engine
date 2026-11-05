import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import { cachedSource, fetchSource } from "../pack/sources.ts";
import type { AvailableSource, FetchedSource, MachineFile, Preset, Profile, SourceRef } from "../pack/types.ts";
import { loadMachine, loadProfile, saveAnswers, saveMachine, thisMachine } from "../profile/profile.ts";
import { resolve } from "../reconciler/resolve.ts";
import { defaultSources, engineRepo, makesOwnDevbox } from "./defaults.ts";
import { FlagError, hasPicks, parseSetupFlags, type SetupFlags } from "./flags.ts";
import { packList, packsStep, picksFrom, title, plansStep, settingSteps, settingsFrom, waitsForTeams, type Catalog, type Draft, type QuestionContext } from "./questions.ts";
import { realMachine, type Machine } from "./commands.ts";
import { humanStep, packSignIn, type HumanContext } from "./human.ts";
import { devboxQuestion, devboxSteps, profileForBox, type DevboxContext } from "./devbox.ts";
import { doneScreen, finalCheck, repoName, runsByItself } from "./done.ts";
import { profileStep } from "./profile.ts";
import { runSteps, type Step } from "./runner.ts";
import { chatgptSignIn, claudeSignIn, githubSignIn, memberSources } from "./signins.ts";
import { Stopped, type Terminal } from "./terminal.ts";

export type SetupOptions = {
  home: string;
  engineRoot: string;
  platform: NodeJS.Platform;
  terminal: Terminal;
  machine?: Partial<Machine>;
  fetchSource?: (ref: SourceRef, cacheRoot: string) => Promise<FetchedSource>;
  /** Runs fleet apply with this profile and prints its report. */
  apply?: (profileDir: string) => Promise<number>;
  /** Runs fleet doctor with this profile and prints its report. */
  doctor?: (profileDir: string) => Promise<number>;
  /** This machine's IANA time zone, which picks a setting's time-zone default. */
  timeZone?: string;
  /** The environment the standalone check reads, and that tells a Coder workspace apart. */
  env?: Record<string, string | undefined>;
};

/** Steps that run again when the command changes an answer: the profile saves it, apply puts it on this machine, and the check confirms it. */
const answersChanged = ["profile", "apply", "check"];

export const sourceCache = (home: string) => join(home, ".local", "share", "fleet", "sources");

export async function setup(args: string[], options: SetupOptions): Promise<number> {
  const { terminal } = options;
  let flags: SetupFlags;
  const machine: MachineFile = thisMachine(await loadMachine(options.home), options.platform, options.env ?? process.env);
  const progress = { done: machine.setup?.done ?? [], draft: machine.profileDir ? profileDraft(await loadProfile(machine.profileDir)) : ({ ...machine.setup?.draft } as Draft) };
  const catalog = await loadCatalog(options.engineRoot, teamRefs(progress.draft), options.home);
  const remember = () => saveMachine(options.home, { ...machine, setup: machine.profileDir ? { done: progress.done } : { done: progress.done, draft: progress.draft } });
  const box: Machine = { ...realMachine, ...options.machine };
  const fetchTeam = (ref: SourceRef) => (options.fetchSource ?? fetchSource)(ref, sourceCache(options.home));
  if (progress.done.includes("github")) {
    catalog.teamsKnown = true;
    for (const ref of teamRefs(progress.draft)) {
      if (catalog.sources.some((source) => source.ref.name === ref.name)) continue;
      const fetched = await fetchTeam(ref);
      if ("error" in fetched) terminal.print(`  · The ${ref.name} pack could not be fetched (${fetched.error}). Setup goes on without it.`);
      else catalog.add(fetched);
    }
  }
  try {
    flags = parseSetupFlags(args);
    const picked = picksFrom(flags, catalog);
    const fromFlags = settingsFrom(flags, catalog);
    const saved = progress.draft;
    const reopened = [
      ...(hasPicks(flags) && JSON.stringify(picked) !== JSON.stringify({ packs: saved.packs, workflows: saved.workflows ?? {} }) ? ["packs"] : []),
      ...(flags.plan && flags.plan !== saved.plan ? ["plans"] : []),
    ];
    if (reopened.length || Object.entries(fromFlags).some(([key, value]) => saved.settings?.[key] !== value)) reopened.push(...answersChanged);
    progress.done = progress.done.filter((id) => !reopened.some((step) => id === step || id.startsWith(`${step}:`)));
    if (Object.keys(fromFlags).length && !waitsForTeams(flags, catalog)) {
      progress.draft.settings = { ...progress.draft.settings, ...fromFlags };
      await remember();
    }
  } catch (error) {
    if (!(error instanceof FlagError)) throw error;
    terminal.print(`fleet setup: ${error.message}`);
    return 2;
  }
  const context: QuestionContext = {
    terminal,
    flags,
    catalog,
    draft: progress.draft,
    timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    async answer(fields) {
      Object.assign(progress.draft, fields);
      await remember();
    },
  };
  const human: HumanContext = { terminal, machine: box, nonInteractive: flags.nonInteractive };
  const addTeamSources = async () => {
    for (const ref of await memberSources(box)) {
      if (catalog.sources.some((source) => source.ref.name === ref.name)) continue;
      const fetched = await fetchTeam(ref);
      if ("error" in fetched) {
        terminal.print(`  · You are in the ${ref.repo.split("/")[0]} org, but its pack could not be fetched (${fetched.error}). Setup goes on without it.`);
        continue;
      }
      catalog.add(fetched);
      await context.answer({ sources: [...(progress.draft.sources ?? defaultSources), ref] });
      terminal.print(`  ✓ You are in the ${ref.repo.split("/")[0]} org, so the ${packList(fetched.packs.map((pack) => pack.manifest.name), catalog)} pack is ticked`);
    }
    catalog.teamsKnown = true;
    picksFrom(flags, catalog);
    const fromFlags = settingsFrom(flags, catalog);
    if (Object.keys(fromFlags).length) await context.answer({ settings: { ...progress.draft.settings, ...fromFlags } });
  };
  const profile = profileStep({
    terminal,
    machine: box,
    home: options.home,
    engineRoot: options.engineRoot,
    nonInteractive: flags.nonInteractive,
    draft: progress.draft,
    packs: catalog.packs.map((pack) => pack.manifest),
    async saved(dir) {
      machine.profileDir = dir;
      await remember();
    },
  });
  const applyStep: Step = {
    id: "apply",
    title: machine.role === "mac" ? "Set up this Mac" : "Set up this machine",
    minutes: 3,
    kind: "auto",
    async run() {
      if (!machine.profileDir || !options.apply) throw new Error("no profile to apply yet");
      terminal.print(`▶ ${applyStep.title}: fleet apply installs your packs`);
      if ((await options.apply(machine.profileDir)) !== 0) throw new Error("fleet apply could not set up this machine. Fix what it says above, then run fleet setup again.");
    },
  };
  const question = devboxQuestion({
    terminal,
    home: options.home,
    flag: flags.devbox,
    nonInteractive: flags.nonInteractive,
    async answer(host) {
      machine.devboxes = host ? [host] : [];
      await remember();
    },
  });
  const devbox: Devbox = {
    question,
    pushed: (step) => ({
      ...step,
      async run() {
        const outcome = await step.run();
        if (outcome !== "unanswered" && machine.profileDir) await saveAnswers(machine.profileDir, { settings: progress.draft.settings ?? {} }, { push: true });
        return outcome;
      },
    }),
    steps: (host, plan) => devboxSteps(host, { terminal, machine: box, nonInteractive: flags.nonInteractive, plan: plan.ai, models: plan.models, profile: () => profileForBox(box, machine.profileDir) }),
  };
  const check = () =>
    finalCheck({
      terminal,
      machine: box,
      home: options.home,
      env: options.env ?? process.env,
      devboxes: machine.devboxes ?? [],
      doctor: () => (machine.profileDir && options.doctor ? options.doctor(machine.profileDir) : Promise.resolve(1)),
    });
  const steps = () => [...setupSteps(context, machine, options, human, addTeamSources, [profile, applyStep], devbox), check()];
  try {
    const result = await runSteps(steps, {
      terminal,
      done: progress.done,
      async save(done) {
        progress.done = done;
        await remember();
      },
    });
    if (result.unanswered.length) return printNeeds(terminal, steps(), result.unanswered), 2;
    const { plan } = planFor(context, machine);
    const summary = {
      role: machine.role,
      packs: plan.packs.filter((pack) => pack.available && pack.name !== "base").map((pack) => title(pack.name, catalog.packs)),
      devboxes: machine.devboxes ?? [],
      profileRepo: repoName((await profileForBox(box, machine.profileDir)).url),
      runsByItself: runsByItself(
        plan,
        catalog.packs.map((pack) => pack.manifest),
        (machine.devboxes ?? []).map((host) => ({ host, plan: planFor(context, { ...machine, role: "devbox" }).plan })),
      ),
    };
    for (const line of doneScreen(summary)) terminal.print(line);
    return 0;
  } catch (error) {
    if (error instanceof FlagError) {
      terminal.print(`fleet setup: ${error.message}`);
      return 2;
    }
    if (!(error instanceof Stopped)) throw error;
    const next = steps().find((step) => !progress.done.includes(step.id));
    terminal.print("");
    terminal.print(`Stopped. Run fleet setup again to pick up${next ? ` at ${next.title}` : ""}.`);
    return 130;
  }
}

type Devbox = { question: Step; pushed(step: Step): Step; steps(host: string, plan: { ai: DevboxContext["plan"]; models: DevboxContext["models"] }): Step[] };

function planFor(context: QuestionContext, machine: MachineFile) {
  const draft = context.draft.packs ? context.draft : { ...context.draft, ...picksFrom(context.flags, context.catalog) };
  const profile = draftProfile(draft);
  const fetched = new Set(context.catalog.sources.map((source) => source.ref.name));
  return { profile, plan: resolve(profile, machine, [...context.catalog.sources, ...profile.sources.filter((ref) => !fetched.has(ref.name)).map(notFetched)]) };
}

function setupSteps(context: QuestionContext, machine: MachineFile, options: SetupOptions, human: HumanContext, signedIn: () => Promise<void>, machineSteps: Step[], devbox: Devbox): Step[] {
  const { profile, plan } = planFor(context, machine);
  const box = human.machine;
  const sshDevbox = !makesOwnDevbox(profile.packs) && (machine.role === "mac" || machine.role === "linux");
  const devboxAsk = sshDevbox && machine.devboxes?.length ? planFor(context, { ...machine, role: "devbox" }).plan.ask.filter((setting) => !plan.ask.some((asked) => asked.key === setting.key)) : [];
  return [
    bootstrapStep(context.terminal, box.has),
    humanStep(githubSignIn(box, signedIn), human),
    packsStep(context),
    plansStep(context),
    ...settingSteps(context, plan.ask),
    ...machineSteps,
    ...plan.human.map((step) => humanStep(packSignIn(step, plan.steps, human, plan.engineRoot), human)),
    ...(sshDevbox ? [devbox.question] : []),
    ...settingSteps(context, devboxAsk).map(devbox.pushed),
    ...(plan.ai === "codex" ? [] : [humanStep(claudeSignIn(box), human)]),
    ...(plan.ai === "claude" ? [] : [humanStep(chatgptSignIn(box, plan.models), human)]),
    ...(sshDevbox ? (machine.devboxes ?? []).flatMap((host) => devbox.steps(host, plan)) : []),
  ];
}

function profileDraft(profile: Profile): Draft {
  return { packs: profile.packs, plan: profile.plan, settings: profile.settings, workflows: profile.workflows, sources: profile.sources };
}

function teamRefs(draft: Draft) {
  const skills = new Set(defaultSources.map((source) => source.name));
  return (draft.sources ?? []).filter((source) => !skills.has(source.name));
}

function bootstrapStep(terminal: Terminal, has: Machine["has"]): Step {
  return {
    id: "bootstrap",
    title: "Install the basics",
    minutes: 4,
    kind: "auto",
    async run() {
      const missing = ["git", "gh", "bun", "t3"].filter((tool) => !has(tool));
      if (missing.length) throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Install them with get.sh, then run fleet setup again.`);
      terminal.print("  ✓ Git, gh, Bun and T3 Code are installed");
    },
  };
}

export function draftProfile(draft: Draft, dir = ""): Profile {
  return {
    schema: 1,
    dir,
    engine: { repo: engineRepo, ref: "main", channel: "release" },
    sources: draft.sources ?? defaultSources,
    packs: draft.packs ?? [],
    plan: draft.plan ?? "both",
    settings: draft.settings ?? {},
    workflows: draft.workflows ?? {},
  };
}

function notFetched(ref: SourceRef): FetchedSource {
  return { ref, error: "not fetched during the questions" };
}

/** The engine's packs plus each team source this machine has fetched, such as an org's private pack. */
export async function loadCatalog(engineRoot: string, team: SourceRef[], home: string): Promise<Catalog> {
  const presets = (await Bun.file(join(engineRoot, "presets.json")).json()) as Preset[];
  const engine: AvailableSource = { ref: { name: "engine", repo: engineRepo, ref: "main" }, dir: engineRoot, packs: await loadPacks(engineRoot) };
  const catalog: Catalog = {
    presets,
    sources: [engine],
    packs: [...engine.packs],
    teamPacks: [],
    teamsKnown: false,
    add(source) {
      catalog.sources.push(source);
      catalog.packs.push(...source.packs);
      catalog.teamPacks.push(...source.packs.map((pack) => pack.manifest.name));
    },
  };
  for (const ref of team) {
    const cached = await cachedSource(ref, sourceCache(home));
    if (!("error" in cached)) catalog.add(cached);
  }
  return catalog;
}

function printNeeds(terminal: Terminal, steps: Step[], open: string[]) {
  terminal.print("");
  terminal.print("fleet setup --non-interactive needs these answers and sign-ins. Add the answers to the command and run it again:");
  for (const step of steps.filter((item) => open.includes(item.id))) {
    if (step.kind === "question") terminal.print(`  --set ${step.id.replace(/^setting:/, "")}=<value>   ${step.title}`);
    else terminal.print(`  ${step.title}: do it once in a terminal, then run fleet setup again`);
  }
}
