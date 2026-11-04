import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import { cachedSource, fetchSource } from "../pack/sources.ts";
import type { AvailableSource, FetchedSource, MachineFile, Preset, Profile, SourceRef } from "../pack/types.ts";
import { loadMachine, saveMachine } from "../profile/profile.ts";
import { resolve } from "../reconciler/resolve.ts";
import { defaultSources, engineRepo } from "./defaults.ts";
import { FlagError, hasPicks, parseSetupFlags, type SetupFlags } from "./flags.ts";
import { packList, packsStep, picksFrom, plansStep, settingSteps, settingsFrom, type Catalog, type Draft, type QuestionContext } from "./questions.ts";
import { realMachine, type Machine } from "./commands.ts";
import { humanStep, packSignIn, type HumanContext } from "./human.ts";
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
};

export const sourceCache = (home: string) => join(home, ".local", "share", "fleet", "sources");

export async function setup(args: string[], options: SetupOptions): Promise<number> {
  const { terminal } = options;
  let flags: SetupFlags;
  const machine: MachineFile = (await loadMachine(options.home)) ?? { schema: 1, role: options.platform === "darwin" ? "mac" : "linux" };
  const progress = { done: machine.setup?.done ?? [], draft: { ...machine.setup?.draft } as Draft };
  const catalog = await loadCatalog(options.engineRoot, teamRefs(progress.draft), options.home);
  const remember = () => saveMachine(options.home, { ...machine, setup: { done: progress.done, draft: progress.draft } });
  const box: Machine = { ...realMachine, ...options.machine };
  const fetchTeam = (ref: SourceRef) => (options.fetchSource ?? fetchSource)(ref, sourceCache(options.home));
  if (progress.done.includes("github")) {
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
    progress.done = progress.done.filter((id) => !reopened.includes(id));
    if (Object.keys(fromFlags).length) {
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
  };
  const steps = () => setupSteps(context, machine, options, human, addTeamSources);
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
    terminal.print("");
    terminal.print("Your answers are saved on this machine. The next steps of setup come in a later version of Fleet.");
    return 0;
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    const next = steps().find((step) => !progress.done.includes(step.id));
    terminal.print("");
    terminal.print(`Stopped. Run fleet setup again to pick up${next ? ` at ${next.title}` : ""}.`);
    return 130;
  }
}

function setupSteps(context: QuestionContext, machine: MachineFile, options: SetupOptions, human: HumanContext, signedIn: () => Promise<void>): Step[] {
  const draft = context.draft.packs ? context.draft : { ...context.draft, ...picksFrom(context.flags, context.catalog) };
  const profile = draftProfile(draft);
  const fetched = new Set(context.catalog.sources.map((source) => source.ref.name));
  const plan = resolve(profile, machine, [...context.catalog.sources, ...profile.sources.filter((ref) => !fetched.has(ref.name)).map(notFetched)]);
  const box = human.machine;
  return [
    bootstrapStep(context.terminal, box.has),
    humanStep(githubSignIn(box, signedIn), human),
    packsStep(context),
    plansStep(context),
    ...settingSteps(context, plan.ask),
    ...plan.human.map((step) => humanStep(packSignIn(step, plan.steps, human), human)),
    ...(plan.ai === "codex" ? [] : [humanStep(claudeSignIn(box), human)]),
    ...(plan.ai === "claude" ? [] : [humanStep(chatgptSignIn(box, plan.models), human)]),
  ];
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
