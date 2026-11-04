import type { LoadedPack, Plan, ProfileFile } from "../pack/types.ts";
import { saveAnswers } from "../profile/profile.ts";

/** What fleet packs, fleet settings and fleet set work on: the profile on this machine and every pack its sources offer. */
export type ChangeContext = {
  profileDir: string;
  profile: ProfileFile;
  plan: Plan;
  packs: LoadedPack[];
  print(line: string): void;
  apply(): Promise<number>;
};

/** Commits and pushes the change, then applies it here; other machines take it at their next update. */
export async function saveAndApply(context: ChangeContext, answers: Partial<ProfileFile>, what: string) {
  await saveAnswers(context.profileDir, answers, { push: true });
  context.print(`✓ Saved ${what} in your profile and pushed it.`);
  const code = await context.apply();
  if (code !== 0) return context.print("The change is saved. Fix what it says above, then run fleet apply."), code;
  context.print("This machine has it now. Your other machines pick it up at their next fleet update.");
  return 0;
}

export function manifests(context: ChangeContext) {
  return context.packs.map((pack) => pack.manifest);
}

export function activePacks(context: ChangeContext) {
  const on = new Set(context.plan.packs.filter((pack) => pack.available).map((pack) => pack.name));
  return manifests(context).filter((manifest) => on.has(manifest.name));
}
