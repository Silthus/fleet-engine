import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertBox, boxNameFor, claudeTokenPath, handOver, hubForward, link, linkFile, recordedEnvironment, restoreForwards, startUnit, stopUnit, t3Port, unitOf, unlink, type BoxCoder } from "./links.ts";
import { quote, remoteFleet, type Machine } from "./machine.ts";
import * as registry from "./pool.ts";

export type PoolClient = { claim(): Promise<string | undefined>; give(box: string): Promise<boolean>; drop(box: string): Promise<void> };
export type BoxHooks = { stopping?(box: string): void };

const readyLimitMs = 15 * 60_000;
const applyLimitMs = 15 * 60_000;
const activeStatuses = new Set(["pending", "starting", "running"]);
const servingIdleAfterMs = 24 * 3_600_000;
const busyLife = "2h";
const linkFreshMs = 21 * 86_400_000;
const machineFileCheck = "test -f ~/.config/fleet/machine.json";

const claimRecord = (claim: string) => `mkdir -p ~/.config/fleet && printf '%s\\n' ${quote(claim)} > ~/.config/fleet/box-claim`;
const restartT3 = [
  "systemctl --user restart t3code.service",
  `for i in $(seq 60); do curl -fs http://127.0.0.1:${t3Port}/.well-known/t3/environment > /dev/null && break; sleep 1; done`,
  `curl -fs http://127.0.0.1:${t3Port}/.well-known/t3/environment > /dev/null || exit 1`,
];
const claudeSignIn = [
  `token="$HOME/${claudeTokenPath}" dir="$HOME/.config/systemd/user/t3code.service.d" changed=`,
  'if [ -s "$token" ]; then',
  String.raw`  (umask 077 && mkdir -p "$dir" && { printf '[Service]\nEnvironment="CLAUDE_CODE_OAUTH_TOKEN='; tr -d '\n' < "$token"; printf '"\n'; } > "$dir/claude-token.conf.new") || exit 1`,
  '  if cmp -s "$dir/claude-token.conf.new" "$dir/claude-token.conf"; then rm -f "$dir/claude-token.conf.new"; else mv -f "$dir/claude-token.conf.new" "$dir/claude-token.conf" && systemctl --user daemon-reload && changed=1; fi',
  "fi",
];

export const setUpScript = (claim: string) => [claimRecord(claim), ...claudeSignIn, ...restartT3].join("\n");
export const claimScript = (claim: string) => [claimRecord(claim), ...claudeSignIn, 'if [ -n "$changed" ]; then', ...restartT3, "fi"].join("\n");

export function recycleScript(keepDirs: string[]): string {
  const clearDev = keepDirs.length ? `for d in ~/dev/*; do case "\${d##*/}" in ${keepDirs.map(quote).join("|")}) ;; *) rm -rf "$d" ;; esac; done` : 'for d in ~/dev/*; do rm -rf "$d"; done';
  return ["systemctl --user stop fleet-heavy.slice 2>/dev/null", "rm -rf ~/.t3/worktrees/*/* ~/.t3/scratch/*", clearDev, "rm -f ~/.config/fleet/box-claim", "true"].join("\n");
}

const claimLine = (here: Machine, label: string) => `${label} by ${here.self} at ${new Date(here.now()).toISOString()}`;
const statusOf = (coder: Pick<BoxCoder, "boxes">, box: string) => coder.boxes().find((candidate) => candidate.name === box)?.status ?? "gone";

async function waitReady(coder: BoxCoder, here: Machine, box: string): Promise<void> {
  const deadline = here.now() + readyLimitMs;
  while (here.now() < deadline) {
    const status = statusOf(coder, box);
    if (!activeStatuses.has(status)) throw new Error(`${box} is ${status}, so it will not become ready.`);
    if (status === "running" && coder.sshAfterStartup(box, "true").code === 0) return;
    await here.sleep(5000);
  }
  throw new Error(`${box} was not ready after ${readyLimitMs / 60_000} minutes.`);
}

async function waitForApply(coder: BoxCoder, here: Machine, box: string): Promise<void> {
  const deadline = here.now() + applyLimitMs;
  while (coder.ssh(box, machineFileCheck).code !== 0) {
    if (here.now() >= deadline) throw new Error(`${box} did not finish fleet apply within ${applyLimitMs / 60_000} minutes: it has no ~/.config/fleet/machine.json. Read its Coder startup log.`);
    await here.sleep(5000);
  }
}

async function settled(coder: BoxCoder, here: Machine, box: string): Promise<string> {
  const deadline = here.now() + readyLimitMs;
  for (;;) {
    const status = statusOf(coder, box);
    if (!["pending", "starting", "stopping", "canceling"].includes(status) || here.now() > deadline) return status;
    await here.sleep(5000);
  }
}

function onEveryPeer(here: Machine, command: string): string[] {
  return here.peers.filter((alias) => {
    const result = here.onPeer(alias, command);
    here.say(`${alias}: ${result.code === 0 ? "done" : `failed (${(result.stderr || result.stdout).trim().split("\n").at(-1)})`}`);
    return result.code !== 0;
  });
}

function stopwatch(here: Machine, box: string, label: string, source: "pool" | "new") {
  const began = here.now();
  const steps: Record<string, number> = {};
  let last = began;
  return {
    step(name: string) {
      steps[name] = Math.round((here.now() - last) / 1000);
      last = here.now();
    },
    done(ok: boolean) {
      const log = join(here.home, ".local/state/fleet/box-spawn.jsonl");
      mkdirSync(dirname(log), { recursive: true });
      appendFileSync(log, `${JSON.stringify({ at: new Date(began).toISOString(), box, label, source, ok, seconds: Math.round((here.now() - began) / 1000), steps })}\n`);
    },
  };
}

function signInNotes(here: Machine, box: string): void {
  if (!existsSync(join(here.home, claudeTokenPath))) here.say(`Claude is not signed in on ${box}. Make a token with claude setup-token, paste it into fleet box token, and spawn again.`);
  if (here.codex) here.say(`Codex on ${box} needs its own sign-in: fleet box run ${box} -- codex login --device-auth`);
}

export function poolOn(here: Machine): PoolClient {
  if (here.isHub) {
    const file = registry.poolFile(here.home);
    return { claim: () => registry.claim(file), give: (box) => registry.give(file, box, here.settings.poolSize), drop: (box) => registry.drop(file, box) };
  }
  const ask = (command: string) => here.onPeer(here.settings.alias, remoteFleet(`box pool ${command}`));
  return {
    claim: async () => {
      const answer = ask("claim");
      return answer.code === 0 ? answer.stdout.trim() || undefined : undefined;
    },
    give: async (box) => {
      const answer = ask(`give ${box}`);
      if (answer.code === 0 || answer.code === 3) return answer.code === 0;
      throw new Error(`the hub did not answer about the pool (exit ${answer.code}); ${box} stays stopped. Run fleet box release ${box} again later`);
    },
    drop: async (box) => void ask(`drop ${box}`),
  };
}

function finish(here: Machine, box: string, environmentId: string, unlinked: string[]) {
  if (unlinked.length) here.say(`not linked on ${unlinked.join(", ")}; run fleet box link ${box} there`);
  signInNotes(here, box);
  here.print(`${box} ${environmentId}`);
}

async function claimFromPool(coder: BoxCoder, here: Machine, label: string, pool: PoolClient): Promise<boolean> {
  for (let box = await pool.claim(); box; box = await pool.claim()) {
    const watch = stopwatch(here, box, label, "pool");
    try {
      here.say(`claimed ${box} from the pool for ${label}`);
      if ((await settled(coder, here, box)) !== "running") await coder.start(box);
      await waitReady(coder, here, box);
      watch.step("start");
      const cleaned = coder.ssh(box, `bash -lc ${quote(recycleScript(here.settings.keepDirs))}`);
      if (cleaned.code !== 0) throw new Error(`cleaning failed: ${(cleaned.stderr || cleaned.stdout).trim()}`);
      startUnit(coder, here, unitOf(box, "hub"), hubForward(here, box));
      handOver(coder, here, box);
      if (coder.ssh(box, `bash -lc ${quote(claimScript(claimLine(here, label)))}`).code !== 0) throw new Error("T3 did not answer after its restart with the new Claude token");
      watch.step("setup");
      const record = linkFile(here, box);
      const fresh = existsSync(record) && here.now() - statSync(record).mtimeMs < linkFreshMs;
      const environmentId = fresh ? recordedEnvironment(here, box) : await link(coder, here, box);
      const t3 = `${unitOf(box, "t3")}.service`;
      if (fresh) {
        here.run(["systemctl", "--user", "try-restart", t3]);
        restoreForwards(coder, here);
      }
      const relink = `r=~/.config/fleet/boxes/${box}.json && if test -n "$(find "$r" -mtime -21 2>/dev/null)"; then systemctl --user try-restart ${t3}; else ${remoteFleet(`box link ${box}`)}; fi`;
      const unlinked = onEveryPeer(here, relink);
      watch.step("link");
      watch.done(true);
      finish(here, box, environmentId, unlinked);
      return true;
    } catch (error) {
      watch.done(false);
      stopUnit(here, unitOf(box, "hub"));
      here.say(`${box} from the pool failed (${(error as Error).message}); it leaves the pool. Trying the next one.`);
    }
  }
  return false;
}

export async function spawn(coder: BoxCoder, here: Machine, name?: string, pool?: PoolClient): Promise<number> {
  const label = name ?? "a lane";
  if (pool && (await claimFromPool(coder, here, label, pool))) return 0;
  const box = boxNameFor(name ?? crypto.randomUUID().slice(0, 6));
  const watch = stopwatch(here, box, name ?? box, "new");
  here.say(`create ${box} with a ${here.settings.diskGigabytes} GB disk`);
  await coder.create(box, here.workspace, here.settings.diskGigabytes);
  try {
    await waitReady(coder, here, box);
    watch.step("create");
    here.say(`${box} is up; wait for fleet apply on it`);
    await waitForApply(coder, here, box);
    watch.step("apply");
    startUnit(coder, here, unitOf(box, "hub"), hubForward(here, box));
    handOver(coder, here, box);
    if (coder.ssh(box, `bash -lc ${quote(setUpScript(claimLine(here, label)))}`).code !== 0) throw new Error(`Setting up ${box} failed: T3 did not answer after its restart.`);
    watch.step("setup");
    const environmentId = await link(coder, here, box);
    const unlinked = onEveryPeer(here, remoteFleet(`box link ${box}`));
    watch.step("link");
    watch.done(true);
    finish(here, box, environmentId, unlinked);
    return 0;
  } catch (error) {
    watch.done(false);
    stopUnit(here, unitOf(box, "hub"));
    here.say(`kept ${box} without forwards to look into the failure; the hub's sweep stops it once idle. Delete it with fleet box release ${box} --delete.`);
    throw error;
  }
}

export function isIdle(lastActivity: number, atWork: boolean, idleHours: number, now: number): boolean {
  return now - lastActivity >= (atWork ? servingIdleAfterMs : idleHours * 3_600_000);
}

function readT3State<T>(home: string, read: (state: Database) => T, empty: T): T {
  const statePath = join(home, ".t3/userdata/statev2.sqlite");
  if (!existsSync(statePath)) return empty;
  const state = new Database(statePath, { readonly: true });
  try {
    return read(state);
  } finally {
    state.close();
  }
}

const liveTurnSince = (now: number) => new Date(now - servingIdleAfterMs).toISOString();

function t3Activity(home: string, now: number) {
  return readT3State(home, (state) => {
    const latest = state.query("select max(occurred_at) as at from orchestration_events").get() as { at: string | null };
    const running = state.query("select count(*) as turns from orchestration_v2_projection_provider_turns where status = 'running' and started_at > ?").get(liveTurnSince(now)) as { turns: number };
    return { lastEventAt: latest.at ? Date.parse(latest.at) : 0, turnRuns: running.turns > 0 };
  }, { lastEventAt: 0, turnRuns: false });
}

export function unfinishedThreads(state: Database, now: number): string[] {
  const rows = state.query(`
    select t.title || ' (runs)' as thread from orchestration_v2_projection_provider_turns p
      join orchestration_v2_projection_threads t using (thread_id)
      where p.status = 'running' and p.started_at > ? and t.deleted_at is null
    union
    select t.title || ' (waits for an answer)' from orchestration_v2_projection_runtime_requests r
      join orchestration_v2_projection_threads t using (thread_id)
      where r.status = 'pending' and t.deleted_at is null`).all(liveTurnSince(now)) as { thread: string }[];
  return rows.map((row) => row.thread);
}

export function threads(here: Machine): number {
  assertBox(here.workspace);
  for (const thread of readT3State(here.home, (state) => unfinishedThreads(state, here.now()), [] as string[])) here.print(thread);
  return 0;
}

export function idle(here: Machine): number {
  assertBox(here.workspace);
  const now = here.now();
  const bootedAt = now - Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000;
  const claim = join(here.home, ".config/fleet/box-claim");
  const claimedAt = existsSync(claim) ? statSync(claim).mtimeMs : 0;
  const t3 = t3Activity(here.home, now);
  const heavyTasks = Number(here.run(["systemctl", "--user", "show", "fleet-heavy.slice", "-p", "TasksCurrent", "--value"]).stdout.trim());
  const quiet = isIdle(Math.max(bootedAt, claimedAt, t3.lastEventAt), heavyTasks > 0 || t3.turnRuns, here.settings.idleHours, now);
  here.print(quiet ? "idle" : "busy");
  return quiet ? 0 : 1;
}

function unfinishedWorkOn(coder: BoxCoder, box: string): string | undefined {
  const status = statusOf(coder, box);
  if (status !== "running") return `it is ${status}, so its threads cannot be checked. Start it with fleet box start ${box} first`;
  const answer = coder.ssh(box, remoteFleet("box threads"));
  if (answer.code !== 0) return `it did not list its threads (exit ${answer.code}: ${(answer.stderr || answer.stdout).trim()})`;
  const unfinished = answer.stdout.trim();
  if (unfinished) return `these threads still run or wait for an answer:\n${unfinished.split("\n").map((thread) => `  ${thread}`).join("\n")}\nFinish or stop them first`;
  return undefined;
}

export function sweep(coder: BoxCoder, here: Machine, hooks: BoxHooks = {}): number {
  let failed = 0;
  for (const box of coder.boxes().filter((candidate) => candidate.status === "running")) {
    try {
      const answer = coder.ssh(box.name, remoteFleet("box idle"));
      if (answer.code === 0) {
        hooks.stopping?.(box.name);
        coder.stop(box.name);
      } else if (answer.code === 1) coder.extend(box.name, busyLife);
      here.print(`${box.name}: ${answer.code === 0 ? "idle, stopped" : answer.code === 1 ? `busy, kept up for ${busyLife}` : `did not answer (exit ${answer.code}); kept`}`);
    } catch (error) {
      failed = 1;
      here.print(`${box.name}: ${(error as Error).message}`);
    }
  }
  return failed;
}

export async function startBox(coder: BoxCoder, here: Machine, box: string): Promise<number> {
  assertBox(box);
  await coder.start(box);
  await waitReady(coder, here, box);
  const unit = `${unitOf(box, "t3")}.service`;
  here.run(["systemctl", "--user", "try-restart", unit]);
  restoreForwards(coder, here);
  onEveryPeer(here, `systemctl --user try-restart ${unit}; true`);
  here.say(`${box} is up; its T3 forwards reconnect within a minute`);
  return 0;
}

export type ReleaseOptions = { force?: boolean; stillDoomed?: () => boolean; pool?: PoolClient; recycle?: boolean; hooks?: BoxHooks };

export async function release(coder: BoxCoder, here: Machine, box: string, { force = false, stillDoomed = () => true, pool, recycle = true, hooks = {} }: ReleaseOptions = {}): Promise<number> {
  assertBox(box);
  const keep = force ? undefined : unfinishedWorkOn(coder, box);
  if (keep) {
    here.say(`kept ${box}: ${keep}, or release it with --force.`);
    return 1;
  }
  if (!force) hooks.stopping?.(box);
  const hub = `${unitOf(box, "hub")}.service`;
  if (pool && recycle) {
    onEveryPeer(here, `systemctl --user stop ${hub} 2>/dev/null; true`);
    stopUnit(here, unitOf(box, "hub"));
    if (statusOf(coder, box) === "running") coder.stop(box);
    if (await pool.give(box)) {
      here.say(`returned ${box} to the pool and stopped it; the next spawn claims it`);
      return 0;
    }
  }
  await pool?.drop(box);
  const linked = onEveryPeer(here, `${remoteFleet(`box unlink ${box}`)}; unlinked=$?; systemctl --user stop ${hub} 2>/dev/null; exit $unlinked`);
  if (!unlink(here, box)) linked.push(here.self);
  stopUnit(here, unitOf(box, "hub"));
  if (!stillDoomed()) {
    here.say(`kept ${box}: it started again while it was being released. Link it again with fleet box link ${box}.`);
    return 1;
  }
  coder.remove(box);
  here.say(`deleted ${box}`);
  if (!linked.length) return 0;
  here.say(`still linked on ${linked.join(", ")}; run fleet box unlink ${box} there`);
  return 1;
}

export function list(coder: BoxCoder, here: Machine): number {
  for (const box of coder.boxes()) here.print(`${box.name}  ${box.status}  last used ${box.lastUsedAt}`);
  return 0;
}

export async function refreshPool(coder: BoxCoder, here: Machine): Promise<number> {
  const file = registry.poolFile(here.home);
  const boxes = await registry.withPool(file, (pool) => {
    const taken = pool.free.splice(0);
    pool.refreshing.push(...taken);
    return taken;
  }, here);
  const warm = [recycleScript(here.settings.keepDirs), ...(here.settings.warmCommand ? [here.settings.warmCommand] : [])].join("\n");
  const results = await Promise.all(boxes.map(async (box) => {
    let usable = false;
    try {
      if (statusOf(coder, box) !== "running") await coder.start(box, { update: true });
      await waitReady(coder, here, box);
      usable = true;
      const record = linkFile(here, box);
      if (!existsSync(record) || here.now() - statSync(record).mtimeMs >= linkFreshMs) {
        await link(coder, here, box);
        onEveryPeer(here, remoteFleet(`box link ${box}`));
      }
      const warmed = await coder.sshLater(box, `bash -lc ${quote(warm)}`);
      coder.stop(box);
      here.print(`${box}: ${warmed.code === 0 ? "refreshed" : `refresh failed (exit ${warmed.code}); kept in the pool`}`);
      return warmed.code === 0;
    } catch (error) {
      here.print(`${box}: ${(error as Error).message}${usable ? "; kept in the pool" : "; it leaves the pool"}`);
      return false;
    } finally {
      await registry.withPool(file, (pool) => {
        pool.refreshing = pool.refreshing.filter((name) => name !== box);
        if (usable) pool.free.push(box);
      }, here);
    }
  }));
  here.print(`${results.filter(Boolean).length} of ${boxes.length} pooled boxes refreshed`);
  return results.every(Boolean) ? 0 : 1;
}

export type NightlyStep = { name: string; run(): number | Promise<number> };
export type NightlyParts = { reap(): Promise<number>; grant(devbox: string): number; refresh(): Promise<number> };

export function nightlySteps(here: Machine, parts: NightlyParts): NightlyStep[] {
  return [
    { name: "reap", run: parts.reap },
    ...here.devboxes.map((devbox) => ({ name: `grant ${devbox}`, run: () => parts.grant(devbox) })),
    { name: "refresh the pool", run: parts.refresh },
  ];
}

export async function nightly(steps: NightlyStep[], here: Machine): Promise<number> {
  let status = 0;
  for (const step of steps) {
    here.say(`${new Date(here.now()).toISOString()} ${step.name}`);
    try {
      const code = await step.run();
      if (code !== 0) {
        status = 1;
        here.say(`${step.name} failed (exit ${code})`);
      }
    } catch (error) {
      status = 1;
      here.say(`${step.name} failed: ${(error as Error).message}`);
    }
  }
  return status;
}

export async function saveToken(home: string, pasted: string): Promise<void> {
  const token = pasted.trim();
  if (!token) throw new Error("No token on standard input. Run claude setup-token, then paste the token it prints into fleet box token.");
  const path = join(home, claudeTokenPath);
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, `${token}\n`, { mode: 0o600 });
  await chmod(partial, 0o600);
  await rename(partial, path);
}
