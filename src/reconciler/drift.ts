import type { Finding, HumanStep, Owned, Plan } from "../pack/types.ts";

const healthLimitMs = 3000;

/** What doctor adds to tell nodes apart from the hub: the profile commit this machine follows, and each served service that does not answer at loopback. The hub skips a service whose install step is still left, which doctor names already. */
export async function drift(plan: Plan, left: Array<Owned<HumanStep>>): Promise<Finding[]> {
  const findings: Finding[] = [];
  const commit = plan.machine.profileDir ? await profileCommit(plan.machine.profileDir) : undefined;
  if (commit) findings.push({ id: "drift:profile", pack: "engine", say: `Your profile is at commit ${commit}. Every node of it should show the same commit.` });
  if (!plan.onHub && !plan.reachesHub) return findings;
  for (const entry of plan.catalog ?? []) {
    if (entry.after && left.some((step) => step.pack === entry.pack && step.id === entry.after)) continue;
    const url = `http://127.0.0.1:${entry.port}${entry.health}`;
    if (await answers(url)) continue;
    const where = plan.reachesHub ? `Check this machine's forward to the hub ${plan.hub}, and the service on the hub.` : "Check the service on this machine.";
    findings.push({ id: `drift:${entry.pack}/${entry.id}`, pack: entry.pack, say: `${entry.pack}/${entry.id} does not answer at ${url}. ${where}`, repair: "human" });
  }
  return findings;
}

async function answers(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(healthLimitMs) })).ok;
  } catch {
    return false;
  }
}

async function profileCommit(dir: string) {
  try {
    const child = Bun.spawn(["git", "-C", dir, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? out.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}
