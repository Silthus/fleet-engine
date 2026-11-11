import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LockBusy, lockBox, tryLockBox, userWaitMs, withBoxLock, type HeldLock, type LockOptions } from "./box-lock.ts";
import { assertBox, boxMarkerPath, boxNameFor, claudeTokenPath, handOver, hubForward, link, linkFile, recordedEnvironment, restoreForward, startUnit, stopUnit, t3Port, unitOf, unlink, type BoxCoder } from "./links.ts";
import type { Box } from "./coder.ts";
import { quote, remoteFleet, type Machine } from "./machine.ts";
import { writePrivateFile } from "../../mcp-gateway/lib/client.ts";
import * as registry from "./pool.ts";

export type BoxHooks = { stopping?(box: string): void | Promise<void> };

const readyLimitMs = 15 * 60_000;
const applyLimitMs = 15 * 60_000;
export const startLimitMs = 5 * 60_000;
const settleLimitMs = 10 * 60_000;
const idleCheckLimitMs = 2 * 60_000;
const warmLimitMs = 60 * 60_000;
const gatewayCheckLimitMs = 60_000;
const gatewayChecks = 3;
const activeStatuses = new Set(["pending", "starting", "running"]);
const transitional = new Set(["pending", "starting", "stopping", "canceling", "deleting"]);
const servingIdleAfterMs = 24 * 3_600_000;
const busyLifeMs = 2 * 3_600_000;
const linkFreshMs = 21 * 86_400_000;
const machineFileCheck = "test -f ~/.config/fleet/machine.json";

const claimRecord = (claim: string) => `mkdir -p ~/.config/fleet && printf '%s\\n' ${quote(claim)} > ~/.config/fleet/box-claim && { [ -e ~/${boxMarkerPath} ] || [ -L ~/${boxMarkerPath} ] || : > ~/${boxMarkerPath}; }`;
const restartT3 = [
  "systemctl --user restart t3code.service",
  `for i in $(seq 60); do curl -fs http://127.0.0.1:${t3Port}/.well-known/t3/environment > /dev/null && break; sleep 1; done`,
  `curl -fs http://127.0.0.1:${t3Port}/.well-known/t3/environment > /dev/null || exit 1`,
];
const straight = `straight() {
  path=$HOME rest=\${1#"$HOME"/}
  while [ -n "$rest" ]; do
    path=$path/\${rest%%/*}
    case $rest in */*) rest=\${rest#*/} ;; *) rest= ;; esac
    if [ -L "$path" ]; then echo "Fleet box: will not $2: $path is a symlink" >&2; return 1; fi
  done
}`;
const probe = `probe() {
  path=$HOME rest=\${1#"$HOME"/}
  while :; do
    if [ ! -d "$path" ] || [ ! -x "$path" ]; then echo "Fleet box: cannot search $path" >&2; return 2; fi
    [ -n "$rest" ] || break
    path=$path/\${rest%%/*}
    case $rest in */*) rest=\${rest#*/} ;; *) rest= ;; esac
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then return 1; fi
  done
  if [ ! -r "$path" ]; then echo "Fleet box: cannot list $path" >&2; return 2; fi
}`;
const claudeSignIn = [
  straight,
  `token="$HOME/${claudeTokenPath}" dir="$HOME/.config/systemd/user/t3code.service.d" changed=`,
  'conf="$dir/claude-token.conf" refusal="write the Claude token"',
  'if [ -s "$token" ]; then',
  '  straight "$dir" "$refusal" || exit 1',
  '  (umask 077 && mkdir -p "$dir") || exit 1',
  '  straight "$conf" "$refusal" || exit 1',
  '  if [ -d "$conf" ]; then echo "Fleet box: will not $refusal: $conf is a folder" >&2; exit 1; fi',
  '  new=$(mktemp "$dir/.claude-token.XXXXXX") || exit 1',
  String.raw`  { printf '[Service]\nEnvironment="CLAUDE_CODE_OAUTH_TOKEN='; tr -d '\n' < "$token"; printf '"\n'; } > "$new" || { rm -f "$new"; exit 1; }`,
  '  if [ -f "$conf" ] && cmp -s "$new" "$conf"; then rm -f "$new"; else mv -fT "$new" "$conf" && systemctl --user daemon-reload && changed=1; fi',
  "fi",
];

export const setUpScript = (claim: string) => [claimRecord(claim), ...claudeSignIn, ...restartT3].join("\n");
export const claimScript = (claim: string) => [claimRecord(claim), ...claudeSignIn, 'if [ -n "$changed" ]; then', ...restartT3, "fi"].join("\n");

const clearHelpers = `${straight}
${probe}
clear_in() {
  root=$1; shift
  straight "$root" "clear $root" || return 1
  probe "$root" || { [ $? = 1 ] && return 0; return 1; }
  real=$(cd -P -- "$root" && pwd -P) || return 1
  cleared=0
  for entry in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    base=\${entry##*/}
    for keep in "$@"; do [ "$base" = "$keep" ] && continue 2; done
    if [ -L "$entry" ]; then rm -f -- "$entry" || cleared=1; continue; fi
    if [ "$(cd -P -- "\${entry%/*}" && pwd -P)" != "$real" ]; then echo "Fleet box: will not clear $entry: it is outside $root" >&2; return 1; fi
    rm -rf -- "$entry" || cleared=1
  done
  return $cleared
}`;

export function recycleScript(keepDirs: string[]): string {
  return [
    "systemctl --user stop fleet-heavy.slice 2>/dev/null",
    clearHelpers,
    "failed=0",
    'clear_in "$HOME/.t3/scratch" || failed=1',
    'if ! straight "$HOME/.t3/worktrees" "clear $HOME/.t3/worktrees"; then failed=1',
    'elif probe "$HOME/.t3/worktrees"; then',
    '  for project in "$HOME"/.t3/worktrees/* "$HOME"/.t3/worktrees/.[!.]* "$HOME"/.t3/worktrees/..?*; do',
    '    if [ -L "$project" ]; then rm -f -- "$project" || failed=1; elif [ -d "$project" ]; then clear_in "$project" || failed=1; fi',
    "  done",
    'elif [ $? = 2 ]; then failed=1; fi',
    `clear_in "$HOME/dev" ${keepDirs.map(quote).join(" ")} || failed=1`,
    "rm -f ~/.config/fleet/box-claim || failed=1",
    '[ "$failed" = 0 ]',
  ].join("\n");
}

const claimLine = (here: Machine, label: string, by: string, claim: string) => `${claim} ${label} by ${by} at ${new Date(here.now()).toISOString()}`;
const readClaim = "cut -d' ' -f1 ~/.config/fleet/box-claim 2>/dev/null";
const readClaimLine = `${probe}
f="$HOME/.config/fleet/box-claim"
if probe "$HOME/.config/fleet"; then
  if [ -e "$f" ] || [ -L "$f" ]; then cat -- "$f"; fi
else
  [ $? = 1 ]
fi`;
const lastLine = (result: { stdout: string; stderr: string }) => (result.stderr || result.stdout).trim().split("\n").at(-1) ?? "";
const holderOf = (line: string) => /^(\S+) .* by (\S+) at \S+$/.exec(line.trim())?.slice(1) ?? [];
const budget = (here: Machine, limitMs: number) => {
  const deadline = here.now() + limitMs;
  return { left: () => deadline - here.now() };
};

type Workspace = { name: string; id: string };

const poolPath = (here: Machine) => registry.poolFile(here.home);
const change = <T>(here: Machine, step: (pool: registry.Pool) => T) => registry.withPool(poolPath(here), step, here);
const liveBox = async (coder: Pick<BoxCoder, "boxes">, box: string, timeoutMs?: number) => (await coder.boxes(timeoutMs)).find((candidate) => candidate.name === box);
const statusById = async (coder: Pick<BoxCoder, "boxes">, id: string, timeoutMs?: number) => (await coder.boxes(timeoutMs)).find((candidate) => candidate.id === id)?.status ?? "gone";
const peersFor = (here: Machine, devbox?: string) => [...new Set([...here.peers, ...(devbox ? [devbox] : [])])].filter((peer) => peer !== here.self && !(here.isHub && peer === here.settings.alias));

export function lockWait(here: Machine, box: string, waitMs: number): LockOptions {
  const minutes = Math.ceil(waitMs / 60_000);
  return { waitMs, waiting: () => here.say(`${box} is busy; waiting up to ${minutes} minute${minutes === 1 ? "" : "s"} for the other operation on it to end`) };
}

async function sameWorkspace(coder: Pick<BoxCoder, "boxes">, box: Workspace): Promise<void> {
  const live = await liveBox(coder, box.name);
  if (live?.id === box.id) return;
  throw new Error(`${box.name} is no longer the workspace this operation holds: Coder has ${live ? "another workspace" : "no workspace"} with that name now. Nothing more is written to it.`);
}

async function settled(coder: BoxCoder, here: Machine, id: string, limitMs = readyLimitMs): Promise<string> {
  const { left } = budget(here, limitMs);
  for (;;) {
    const status = await statusById(coder, id, Math.max(1, left()));
    if (!transitional.has(status) || left() <= 0) return status;
    await here.sleep(Math.min(5000, left()));
  }
}

async function stopById(coder: BoxCoder, here: Machine, box: Workspace): Promise<void> {
  await coder.stop(box.id);
  const status = await settled(coder, here, box.id, settleLimitMs);
  if (status !== "stopped") throw new Error(`${box.name} did not stop: it is ${status}`);
}

async function deleteById(coder: BoxCoder, here: Machine, box: Workspace): Promise<void> {
  await coder.remove(box.id);
  const status = await settled(coder, here, box.id, settleLimitMs);
  if (status !== "gone" && status !== "deleted") throw new Error(`${box.name} was not deleted: it is ${status}`);
}

async function waitReady(coder: BoxCoder, here: Machine, box: Workspace): Promise<void> {
  const { left } = budget(here, readyLimitMs);
  while (left() > 0) {
    const status = await statusById(coder, box.id, left());
    if (!activeStatuses.has(status)) throw new Error(`${box.name} is ${status}, so it will not become ready.`);
    if (status === "running" && left() > 0 && (await coder.sshAfterStartup(box.name, "true", left())).code === 0) return;
    if (left() > 0) await here.sleep(Math.min(5000, left()));
  }
  throw new Error(`${box.name} was not ready after ${readyLimitMs / 60_000} minutes.`);
}

async function waitForApply(coder: BoxCoder, here: Machine, box: string): Promise<void> {
  const { left } = budget(here, applyLimitMs);
  while (left() <= 0 || (await coder.ssh(box, machineFileCheck, undefined, left())).code !== 0) {
    if (left() <= 0) throw new Error(`${box} did not finish fleet apply within ${applyLimitMs / 60_000} minutes: it has no ~/.config/fleet/machine.json. Read its Coder startup log.`);
    await here.sleep(Math.min(5000, left()));
  }
}

async function onEvery(here: Machine, peers: string[], command: string): Promise<string[]> {
  const failed: string[] = [];
  for (const alias of peers) {
    const result = await here.onPeer(alias, command);
    here.say(`${alias}: ${result.code === 0 ? "done" : `failed (${lastLine(result)})`}`);
    if (result.code !== 0) failed.push(alias);
  }
  return failed;
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
  if (!existsSync(join(here.home, claudeTokenPath))) here.say(`Claude is not signed in on ${box}. On the hub, make a token with claude setup-token, paste it into fleet box token, and spawn again.`);
  if (here.codex) here.say(`Codex on ${box} needs its own sign-in: fleet box run ${box} -- codex login --device-auth`);
}

export function ownership(boxes: Box[], here: Machine): { owned: Box[]; skipped: Box[] } {
  const recorded = registry.recorded(poolPath(here));
  const ours = (box: Box) => recorded[box.name]?.id === box.id && box.template === here.settings.template;
  return { owned: boxes.filter(ours), skipped: boxes.filter((box) => !ours(box)) };
}

const skippedLine = (box: string) => `${box}: skipped, not a box this pool made`;
const otherWorkspace = (box: string) => `Coder has another workspace named ${box} now, not the one the pool made. Nothing changed.`;

async function checkGatewayOn(coder: BoxCoder, here: Machine, box: string): Promise<void> {
  let checked = await coder.ssh(box, remoteFleet("run mcp-gateway/mcp-gateway-client"), undefined, gatewayCheckLimitMs);
  for (let attempt = 1; checked.code !== 0 && attempt < gatewayChecks; attempt++) {
    await here.sleep(5000);
    checked = await coder.ssh(box, remoteFleet("run mcp-gateway/mcp-gateway-client"), undefined, gatewayCheckLimitMs);
  }
  if (checked.code !== 0) here.say(`${box} cannot reach the hub's MCP gateway yet (${lastLine(checked) || `exit ${checked.code}`}). Check it with fleet box run ${box} -- fleet run mcp-gateway/mcp-gateway-client`);
}

function finish(here: Machine, box: string, environmentId: string, unlinked: string[]) {
  if (unlinked.length) here.say(`not linked on ${unlinked.join(", ")}; run fleet box link ${box} there`);
  signInNotes(here, box);
  here.print(`${box} ${environmentId}`);
}

export type SpawnOptions = { reuse?: boolean; devbox?: string; waitMs?: number };
type Lane = { label: string; by: string; devbox?: string };

async function setUpPooled(coder: BoxCoder, here: Machine, lane: Lane, box: Workspace, claim: string): Promise<boolean> {
  const live = await liveBox(coder, box.name);
  if (!live || live.id !== box.id || live.template !== here.settings.template) {
    await change(here, (pool) => registry.forget(pool, box.name, box.id));
    here.say(`${box.name}: ${!live ? "it is gone" : live.id !== box.id ? "Coder has another workspace with that name now" : "skipped, not a box this pool made"}; it leaves the pool`);
    return false;
  }
  const watch = stopwatch(here, box.name, lane.label, "pool");
  try {
    here.say(`claimed ${box.name} from the pool for ${lane.label}`);
    if ((await settled(coder, here, box.id)) !== "running") await coder.start(box.id, startLimitMs);
    await waitReady(coder, here, box);
    watch.step("start");
    await sameWorkspace(coder, box);
    const cleaned = await coder.ssh(box.name, `bash -lc ${quote(recycleScript(here.settings.keepDirs))}`);
    if (cleaned.code !== 0) throw new Error(`cleaning failed: ${(cleaned.stderr || cleaned.stdout).trim()}`);
    await startUnit(coder, here, unitOf(box.name, "hub"), hubForward(here, box.name));
    await sameWorkspace(coder, box);
    const gateway = await handOver(coder, here, box.name);
    await sameWorkspace(coder, box);
    if ((await coder.ssh(box.name, `bash -lc ${quote(claimScript(claimLine(here, lane.label, lane.by, claim)))}`)).code !== 0) throw new Error("T3 did not answer after its restart with the new Claude token");
    watch.step("setup");
    const record = linkFile(here, box.name);
    const fresh = existsSync(record) && here.now() - statSync(record).mtimeMs < linkFreshMs;
    const environmentId = fresh ? recordedEnvironment(here, box.name) : await link(coder, here, box.name);
    const t3 = `${unitOf(box.name, "t3")}.service`;
    if (fresh) {
      await here.run(["systemctl", "--user", "try-restart", t3]);
      await restoreForward(coder, here, box.name);
    }
    const relink = `r=~/.config/fleet/boxes/${box.name}.json && if test -n "$(find "$r" -mtime -21 2>/dev/null)"; then systemctl --user try-restart ${t3}; else ${remoteFleet(`box link ${box.name}`)}; fi`;
    const unlinked = await onEvery(here, peersFor(here, lane.devbox), relink);
    if (gateway) await checkGatewayOn(coder, here, box.name);
    watch.step("link");
    watch.done(true);
    await change(here, (pool) => registry.settle(pool, box.name, box.id));
    finish(here, box.name, environmentId, unlinked);
    return true;
  } catch (error) {
    watch.done(false);
    await change(here, (pool) => registry.settle(pool, box.name, box.id));
    await stopUnit(here, unitOf(box.name, "hub"));
    here.say(`${box.name} from the pool failed (${(error as Error).message}); it leaves the pool. Trying the next one.`);
    return false;
  }
}

async function claimFromPool(coder: BoxCoder, here: Machine, lane: Lane): Promise<boolean> {
  for (const box of registry.pooled(poolPath(here))) {
    let unlock: HeldLock;
    try {
      unlock = await lockBox(here.home, box, { waitMs: 0 });
    } catch (error) {
      if (!(error instanceof LockBusy)) throw error;
      here.say(`${box} is busy; trying the next one`);
      continue;
    }
    try {
      const claimed = await unlock.during(async () => {
        const taken = await change(here, (pool) => registry.take(pool, box));
        return !!taken && (await setUpPooled(coder, here, lane, { name: box, id: taken.id }, taken.claim));
      });
      if (claimed) return true;
    } finally {
      unlock();
    }
  }
  return false;
}

async function spawnNew(coder: BoxCoder, here: Machine, lane: Lane, box: string): Promise<number> {
  const watch = stopwatch(here, box, lane.label, "new");
  here.say(`create ${box} with a ${here.settings.diskGigabytes} GB disk`);
  const id = await coder.create(box, here.workspace, here.settings.diskGigabytes);
  const claim = await change(here, (pool) => registry.record(pool, box, id));
  const workspace = { name: box, id };
  try {
    await waitReady(coder, here, workspace);
    watch.step("create");
    here.say(`${box} is up; wait for fleet apply on it`);
    await waitForApply(coder, here, box);
    watch.step("apply");
    await sameWorkspace(coder, workspace);
    await startUnit(coder, here, unitOf(box, "hub"), hubForward(here, box));
    await sameWorkspace(coder, workspace);
    const gateway = await handOver(coder, here, box);
    await sameWorkspace(coder, workspace);
    if ((await coder.ssh(box, `bash -lc ${quote(setUpScript(claimLine(here, lane.label, lane.by, claim)))}`)).code !== 0) throw new Error(`Setting up ${box} failed: T3 did not answer after its restart.`);
    watch.step("setup");
    const environmentId = await link(coder, here, box);
    const unlinked = await onEvery(here, peersFor(here, lane.devbox), remoteFleet(`box link ${box}`));
    if (gateway) await checkGatewayOn(coder, here, box);
    watch.step("link");
    watch.done(true);
    await change(here, (pool) => registry.settle(pool, box, id));
    finish(here, box, environmentId, unlinked);
    return 0;
  } catch (error) {
    watch.done(false);
    await change(here, (pool) => registry.settle(pool, box, id));
    await stopUnit(here, unitOf(box, "hub"));
    here.say(`kept ${box} without forwards to look into the failure; the hub's sweep stops it once idle. Delete it with fleet box release ${box} --delete.`);
    throw error;
  }
}

export async function spawn(coder: BoxCoder, here: Machine, name: string | undefined, { reuse = true, devbox, waitMs = userWaitMs }: SpawnOptions = {}): Promise<number> {
  const lane: Lane = { label: name ?? "a lane", by: devbox ?? here.self, ...(devbox ? { devbox } : {}) };
  if (reuse && (await claimFromPool(coder, here, lane))) return 0;
  const box = boxNameFor(name ?? crypto.randomUUID().slice(0, 6));
  return withBoxLock(here.home, box, lockWait(here, box, waitMs), () => spawnNew(coder, here, lane, box));
}

async function unfinishedWorkOn(coder: BoxCoder, box: Workspace): Promise<string | undefined> {
  const status = await statusById(coder, box.id);
  if (status !== "running") return `it is ${status}, so its threads cannot be checked. Start it with fleet box start ${box.name} first`;
  const answer = await coder.ssh(box.name, remoteFleet("box threads"));
  if (answer.code !== 0) return `it did not list its threads (exit ${answer.code}: ${(answer.stderr || answer.stdout).trim()})`;
  const unfinished = answer.stdout.trim();
  if (unfinished) return `these threads still run or wait for an answer:\n${unfinished.split("\n").map((thread) => `  ${thread}`).join("\n")}\nFinish or stop them first`;
  return undefined;
}

type Finish = { stillDoomed: () => Promise<boolean>; devbox?: string };

async function finishRelease(coder: BoxCoder, here: Machine, box: Workspace, how: registry.Leaving, owned: boolean, { stillDoomed, devbox }: Finish): Promise<number> {
  const peers = peersFor(here, devbox);
  const hub = `${unitOf(box.name, "hub")}.service`;
  const spare = () => (here.say(`kept ${box.name}: it started again while it was being released. Link it again with fleet box link ${box.name}.`), 1);
  if (how === "pool") {
    await onEvery(here, peers, `systemctl --user stop ${hub} 2>/dev/null; true`);
    await stopUnit(here, unitOf(box.name, "hub"));
    if (!(await stillDoomed())) return spare();
    if ((await settled(coder, here, box.id, settleLimitMs)) === "running") await stopById(coder, here, box);
    if (!(await stillDoomed())) return spare();
    if (await change(here, (pool) => registry.giveBack(pool, box.name, box.id, here.settings.poolSize))) {
      here.say(`returned ${box.name} to the pool and stopped it; the next spawn claims it`);
      return 0;
    }
    await change(here, (pool) => registry.leave(pool, box.name, box.id, "delete"));
  }
  const linked = await onEvery(here, peers, `${remoteFleet(`box unlink ${box.name}`)}; unlinked=$?; systemctl --user stop ${hub} 2>/dev/null; exit $unlinked`);
  if (!(await unlink(here, box.name))) linked.push(here.self);
  await stopUnit(here, unitOf(box.name, "hub"));
  if (!(await stillDoomed())) return spare();
  await deleteById(coder, here, box);
  if (owned) await change(here, (pool) => registry.forget(pool, box.name, box.id));
  here.say(`deleted ${box.name}`);
  if (!linked.length) return 0;
  here.say(`still linked on ${linked.join(", ")}; run fleet box unlink ${box.name} there`);
  return 1;
}

const busyLine = (box: string) => `${box}: another operation holds it; skipped`;

async function sweepOne(coder: BoxCoder, here: Machine, name: string, hooks: BoxHooks): Promise<void> {
  const entry = registry.recorded(poolPath(here))[name];
  if (!entry) return;
  const live = await liveBox(coder, name);
  if (!live || live.id !== entry.id) {
    await change(here, (pool) => registry.forget(pool, name, entry.id));
    here.print(`${name}: the box the pool made is gone; forgot it`);
    return;
  }
  if (live.template !== here.settings.template) return;
  const box = { name, id: live.id };
  const half = `${name}: an operation stopped half way`;
  let how = entry.leaving;
  if (entry.claiming && !how) {
    if (live.status !== "running") return here.print(`${half}, and the box is stopped, so its claim cannot be read; kept until it runs`);
    const onBox = await coder.ssh(name, readClaimLine, undefined, idleCheckLimitMs);
    if (onBox.code !== 0) return here.print(`${half}, and the box did not show its claim (exit ${onBox.code}${lastLine(onBox) ? `: ${lastLine(onBox)}` : ""}); kept`);
    if (holderOf(onBox.stdout)[0] !== entry.claim) how = "pool";
    else {
      await change(here, (pool) => registry.settle(pool, name, entry.id));
      here.print(`${half} after its lane claimed it; it stays the lane's`);
    }
  }
  if (how) {
    here.print(`${half}; ${how === "pool" ? "it goes back to the pool" : "it is deleted"}`);
    if ((await finishRelease(coder, here, box, how, true, { stillDoomed: async () => true })) !== 0) throw new Error("finishing its release failed");
    return;
  }
  if (registry.pooled(poolPath(here)).includes(name)) {
    if (live.status !== "running") return;
    await stopById(coder, here, box);
    here.print(`${name}: in the pool but running; stopped`);
    return;
  }
  if (live.status !== "running") return;
  const answer = await coder.ssh(name, remoteFleet("box idle"), undefined, idleCheckLimitMs);
  if (answer.code === 0) {
    await hooks.stopping?.(name);
    await stopById(coder, here, box);
  } else if (answer.code === 1) await coder.extend(box.id, new Date(here.now() + busyLifeMs).toISOString());
  here.print(`${name}: ${answer.code === 0 ? "idle, stopped" : answer.code === 1 ? `busy, kept up for ${busyLifeMs / 3_600_000} hours` : `did not answer (exit ${answer.code}); kept`}`);
}

export async function sweep(coder: BoxCoder, here: Machine, hooks: BoxHooks = {}): Promise<number> {
  let failed = 0;
  const { owned, skipped } = ownership(await coder.boxes(), here);
  for (const box of skipped) here.print(skippedLine(box.name));
  const names = [...new Set([...owned.map((box) => box.name), ...Object.keys(registry.recorded(poolPath(here)))])];
  for (const name of names) {
    const unlock = await tryLockBox(here.home, name);
    if (!unlock) {
      here.print(busyLine(name));
      continue;
    }
    try {
      await unlock.during(() => sweepOne(coder, here, name, hooks));
    } catch (error) {
      failed = 1;
      here.print(`${name}: ${(error as Error).message}`);
    } finally {
      unlock();
    }
  }
  return failed;
}

export type StartOptions = { devbox?: string; waitMs?: number };

async function resume(coder: BoxCoder, here: Machine, box: Workspace, claim: string | undefined, caller: string): Promise<boolean> {
  const onBox = await coder.ssh(box.name, readClaimLine);
  const [held, by] = holderOf(onBox.stdout);
  if (onBox.code !== 0 || held !== claim || by !== caller) return here.say(`${box.name}: a claim of it stopped half way, and the box holds no claim of yours, so it is not resumed. The hub's sweep returns it to the pool, or keeps it for the lane it holds.`), false;
  await change(here, (pool) => registry.settle(pool, box.name, box.id));
  return true;
}

export async function startBox(coder: BoxCoder, here: Machine, box: string, { devbox, waitMs = userWaitMs }: StartOptions = {}): Promise<number> {
  assertBox(box);
  return withBoxLock(here.home, box, lockWait(here, box, waitMs), async () => {
    if (!(await bringUp(coder, here, box, devbox))) return 1;
    const unit = `${unitOf(box, "t3")}.service`;
    await here.run(["systemctl", "--user", "try-restart", unit]);
    await restoreForward(coder, here, box);
    await onEvery(here, peersFor(here, devbox), `systemctl --user try-restart ${unit}; true`);
    here.say(`${box} is up; its T3 forwards reconnect within a minute`);
    return 0;
  });
}

async function bringUp(coder: BoxCoder, here: Machine, box: string, devbox: string | undefined): Promise<boolean> {
  const live = await liveBox(coder, box);
  if (!live) return here.say(`${box} is gone, so it cannot be started.`), false;
  const entry = registry.recorded(poolPath(here))[box];
  if (entry && entry.id !== live.id) return here.say(otherWorkspace(box)), false;
  if (entry?.leaving) return here.say(`${box}: its release began and did not finish, so it is not started. The hub's sweep finishes the release; spawn another box.`), false;
  const workspace = { name: box, id: live.id };
  const taken = entry && !entry.claiming ? await change(here, (pool) => registry.take(pool, box)) : undefined;
  try {
    await coder.start(live.id, startLimitMs);
    await waitReady(coder, here, workspace);
    if (entry?.claiming) return await resume(coder, here, workspace, entry.claim, devbox ?? here.self);
    if (!taken) return true;
    await sameWorkspace(coder, workspace);
    const recorded = await coder.ssh(box, claimRecord(claimLine(here, "fleet box start", devbox ?? here.self, taken.claim)));
    if (recorded.code !== 0) throw new Error(`Cannot record the claim on ${box}: ${recorded.stderr.trim()}`);
    return true;
  } finally {
    if (taken) await change(here, (pool) => registry.settle(pool, box, live.id));
  }
}

export type ReleaseOptions = { force?: boolean; stillDoomed?: () => Promise<boolean>; recycle?: boolean; hooks?: BoxHooks; devbox?: string; waitMs?: number };

export async function release(coder: BoxCoder, here: Machine, box: string, { force = false, stillDoomed = async () => true, recycle = true, hooks = {}, devbox, waitMs = userWaitMs }: ReleaseOptions = {}): Promise<number> {
  assertBox(box);
  const kept = (reason: string) => (here.say(`kept ${box}: ${reason}`), 1);
  if (!force) {
    const status = (await liveBox(coder, box))?.status ?? "gone";
    if (status !== "running") return kept(`it is ${status}, so its threads cannot be checked. Start it with fleet box start ${box} first, or release it with --force.`);
  }
  const expected = force ? undefined : (await coder.ssh(box, readClaim)).stdout.trim();
  return withBoxLock(here.home, box, lockWait(here, box, waitMs), async () => {
    const live = await liveBox(coder, box);
    if (!live) return kept("it is gone. Nothing changed.");
    const entry = registry.recorded(poolPath(here))[box];
    if (entry && entry.id !== live.id) return kept(otherWorkspace(box));
    const owned = !!entry && live.template === here.settings.template;
    if (owned && expected !== undefined && entry.claim !== expected) return kept("it was claimed again since this release read its claim. Nothing changed.");
    if (owned && recycle && registry.pooled(poolPath(here)).includes(box)) return here.say(`${box} is in the pool already`), 0;
    const workspace = { name: box, id: live.id };
    const keep = force ? undefined : await unfinishedWorkOn(coder, workspace);
    if (keep) return kept(`${keep}, or release it with --force.`);
    if (!force) await hooks.stopping?.(box);
    if (!owned && recycle) here.say(`${box} is not a box this pool made, so it is deleted instead of pooled`);
    const how: registry.Leaving = owned && recycle ? "pool" : "delete";
    if (!owned) return finishRelease(coder, here, workspace, how, false, { stillDoomed, ...(devbox ? { devbox } : {}) });
    await change(here, (pool) => registry.leave(pool, box, live.id, how));
    try {
      return await finishRelease(coder, here, workspace, how, true, { stillDoomed, ...(devbox ? { devbox } : {}) });
    } finally {
      await change(here, (pool) => registry.stay(pool, box, live.id));
    }
  });
}

export async function list(coder: BoxCoder, here: Machine): Promise<number> {
  for (const box of await coder.boxes()) here.print(`${box.name}  ${box.status}  last used ${box.lastUsedAt}`);
  return 0;
}

async function refreshOne(coder: BoxCoder, here: Machine, box: string, warm: string): Promise<boolean> {
  const entry = registry.recorded(poolPath(here))[box];
  if (!entry || !registry.pooled(poolPath(here)).includes(box)) return true;
  const live = await liveBox(coder, box);
  if (!live || live.id !== entry.id || live.template !== here.settings.template) {
    await change(here, (pool) => registry.forget(pool, box, entry.id));
    here.print(`${box}: ${live && live.id === entry.id ? "skipped, not a box this pool made" : "the box the pool made is gone"}; it leaves the pool`);
    return true;
  }
  const workspace = { name: box, id: live.id };
  let usable = false;
  try {
    if ((await settled(coder, here, live.id)) !== "running") await coder.start(live.id, startLimitMs, { update: true });
    await waitReady(coder, here, workspace);
    usable = true;
    const record = linkFile(here, box);
    if (!existsSync(record) || here.now() - statSync(record).mtimeMs >= linkFreshMs) {
      await link(coder, here, box);
      await onEvery(here, peersFor(here), remoteFleet(`box link ${box}`));
    }
    await sameWorkspace(coder, workspace);
    const warmed = await coder.ssh(box, `bash -lc ${quote(warm)}`, undefined, warmLimitMs);
    await stopById(coder, here, workspace);
    here.print(`${box}: ${warmed.code === 0 ? "refreshed" : `refresh failed (exit ${warmed.code}); kept in the pool`}`);
    return warmed.code === 0;
  } catch (error) {
    if (!usable) await change(here, (pool) => (registry.take(pool, box), registry.settle(pool, box, live.id)));
    here.print(`${box}: ${(error as Error).message}${usable ? "; kept in the pool" : "; it leaves the pool"}`);
    return false;
  }
}

export async function refreshPool(coder: BoxCoder, here: Machine): Promise<number> {
  const boxes = registry.pooled(poolPath(here));
  const recycle = recycleScript(here.settings.keepDirs);
  const warm = here.settings.warmCommand ? `{\n${recycle}\n} && ${here.settings.warmCommand}` : recycle;
  const results = await Promise.all(boxes.map(async (box) => {
    const unlock = await tryLockBox(here.home, box);
    if (!unlock) return here.print(busyLine(box)), true;
    try {
      return await unlock.during(() => refreshOne(coder, here, box, warm));
    } finally {
      unlock();
    }
  }));
  here.print(`${results.filter(Boolean).length} of ${boxes.length} pooled boxes refreshed`);
  return results.every(Boolean) ? 0 : 1;
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

export async function idle(here: Machine): Promise<number> {
  assertBox(here.workspace);
  const now = here.now();
  const bootedAt = now - Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000;
  const claim = join(here.home, ".config/fleet/box-claim");
  const claimedAt = existsSync(claim) ? statSync(claim).mtimeMs : 0;
  const t3 = t3Activity(here.home, now);
  const heavyTasks = Number((await here.run(["systemctl", "--user", "show", "fleet-heavy.slice", "-p", "TasksCurrent", "--value"])).stdout.trim());
  const quiet = isIdle(Math.max(bootedAt, claimedAt, t3.lastEventAt), heavyTasks > 0 || t3.turnRuns, here.settings.idleHours, now);
  here.print(quiet ? "idle" : "busy");
  return quiet ? 0 : 1;
}

export type NightlyStep = { name: string; run(): number | Promise<number> };
export type NightlyParts = { session(): Promise<number>; reap(): Promise<number>; grant(devbox: string): Promise<number>; refresh(): Promise<number> };

export function nightlySteps(here: Machine, parts: NightlyParts): NightlyStep[] {
  return [
    { name: "check the Coder session", run: parts.session },
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
  await writePrivateFile(path, `${token}\n`);
}
