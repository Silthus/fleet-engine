import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import type { AvailableSource, FetchedSource, MachineFile, Preset, Profile, SourceRef } from "../pack/types.ts";
import { loadMachine, saveMachine } from "../profile/profile.ts";
import { resolve } from "../reconciler/resolve.ts";
import { defaultSources, engineRepo } from "./defaults.ts";
import { FlagError, hasPicks, parseSetupFlags, type SetupFlags } from "./flags.ts";
import { packsStep, picksFrom, plansStep, settingSteps, settingsFrom, type Catalog, type Draft, type QuestionContext } from "./questions.ts";
import { runSteps, type Step } from "./runner.ts";
import { Stopped, type Terminal } from "./terminal.ts";

export type SetupOptions = {
  home: string;
  engineRoot: string;
  platform: NodeJS.Platform;
  terminal: Terminal;
  has?: (tool: string) => boolean;
};

export async function setup(args: string[], options: SetupOptions): Promise<number> {
  const { terminal } = options;
  let flags: SetupFlags;
  const catalog = await loadCatalog(options.engineRoot);
  const machine: MachineFile = (await loadMachine(options.home)) ?? { schema: 1, role: options.platform === "darwin" ? "mac" : "linux" };
  const progress = { done: machine.setup?.done ?? [], draft: { ...machine.setup?.draft } as Draft };
  const remember = () => saveMachine(options.home, { ...machine, setup: { done: progress.done, draft: progress.draft } });
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
  const steps = () => setupSteps(context, machine, options);
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

function setupSteps(context: QuestionContext, machine: MachineFile, options: SetupOptions): Step[] {
  const draft = context.draft.packs ? context.draft : { ...context.draft, ...picksFrom(context.flags, context.catalog) };
  const profile = draftProfile(draft);
  const plan = resolve(profile, machine, [engineSource(context.catalog, options.engineRoot), ...profile.sources.map(notFetched)]);
  return [bootstrapStep(context.terminal, options.has ?? ((tool) => Bun.which(tool) !== null)), packsStep(context), plansStep(context), ...settingSteps(context, plan.ask)];
}

function bootstrapStep(terminal: Terminal, has: (tool: string) => boolean): Step {
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

function engineSource(catalog: Catalog, engineRoot: string): AvailableSource {
  return { ref: { name: "engine", repo: engineRepo, ref: "main" }, dir: engineRoot, packs: catalog.packs };
}

export async function loadCatalog(engineRoot: string): Promise<Catalog> {
  const presets = (await Bun.file(join(engineRoot, "presets.json")).json()) as Preset[];
  return { packs: await loadPacks(engineRoot), presets };
}

function printNeeds(terminal: Terminal, steps: Step[], open: string[]) {
  terminal.print("");
  terminal.print("fleet setup --non-interactive needs these answers. Add them to the command and run it again:");
  for (const step of steps.filter((item) => open.includes(item.id))) {
    const key = step.id.replace(/^setting:/, "");
    terminal.print(`  --set ${key}=<value>   ${step.title}`);
  }
}
