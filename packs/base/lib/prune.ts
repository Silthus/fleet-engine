import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { freeBytes } from "./disk.ts";

export type Facts = {
  path: string;
  kind: "worktree" | "orphan" | "broken" | "main";
  dirty: boolean;
  disposable: boolean;
  branch: string | null;
  unreferenced: number;
  landed: boolean;
  defaultBranch: string | null;
  prMerged: boolean;
  inUse: boolean;
  lastActivity: number;
  thread: Thread | null;
  stateUnknown: boolean;
  agent: boolean;
};

export type Thread = { status: string | null; archived: boolean; deleted: boolean; settled: boolean; pending: boolean; activeAt: number };
export type Verdict = { path: string; remove: boolean; reason: string };
export type PruneOptions = {
  worktreeRoot: string; statePath: string; now: number;
  repos: string[];
  minIdleHours: number;
  unownedIdleHours: number;
  agentIdleHours: number;
  dryRun: boolean;
  fetch: boolean;
  log: (line: string) => void;
  evict?: { targetGigabytes: number; free: () => number };
  sightingsPath: string;
};

const busyStatuses = new Set(["running", "starting", "preparing", "queued"]);
const hour = 3600_000;
const gigabyte = 1024 ** 3;

type IdleLimits = Pick<PruneOptions, "now" | "minIdleHours" | "unownedIdleHours">;

const owned = (facts: Facts) => Boolean(facts.thread) || facts.agent || facts.stateUnknown;
const idleWindow = (facts: Facts, options: IdleLimits) => owned(facts) ? options.minIdleHours : options.unownedIdleHours;

export function decide(facts: Facts, options: IdleLimits & Pick<PruneOptions, "agentIdleHours">): Verdict {
  const keep = (reason: string) => ({ path: facts.path, remove: false, reason });
  const remove = (reason: string) => ({ path: facts.path, remove: true, reason: facts.dirty ? `${reason}; drops lockfile and tool output changes` : reason });
  const idle = (options.now - facts.lastActivity) / hour;
  const closed = facts.thread && closedAs(facts.thread);
  if (facts.kind === "main") return keep("primary checkout");
  if (facts.kind === "broken") return keep("Git cannot read its worktree metadata");
  if (facts.inUse) return keep("a process runs inside it");
  if (facts.stateUnknown) return keep("T3 state is unreadable");
  if (facts.thread?.status && busyStatuses.has(facts.thread.status)) return keep(`T3 session is ${facts.thread.status}`);
  if (facts.thread?.pending) return keep("T3 thread waits for an answer");
  if (idle < options.minIdleHours) return keep(`active ${idle.toFixed(1)}h ago`);
  if (facts.kind === "orphan") {
    if (facts.thread && !closed) return keep("Git does not track it, but its T3 thread is open");
    if (idle < options.unownedIdleHours) return keep(`Git does not track it; active ${idle.toFixed(1)}h ago`);
    return remove("Git does not track it and no open T3 thread uses it");
  }
  if (idle < idleWindow(facts, options)) return keep(`no T3 thread or agent owns it; active ${idle.toFixed(1)}h ago`);
  if (facts.dirty && !(closed && facts.disposable)) return keep("uncommitted changes");
  if (facts.unreferenced > 0) return keep(`${facts.unreferenced} commits exist only in this worktree`);
  if (facts.landed) return remove(`all commits are on ${facts.defaultBranch}`);
  if (facts.prMerged) return remove(`pull request for ${facts.branch} is merged`);
  if (closed) return remove(`T3 thread is ${closed}; commits stay on ${facts.branch ?? "other refs"}`);
  if (facts.agent && idle >= options.agentIdleHours) return remove(`agent worktree idle ${idle.toFixed(1)}h; commits stay on ${facts.branch ?? "other refs"}`);
  return keep("unmerged work");
}

export function evictable(facts: Facts, options: IdleLimits): boolean {
  const idle = (options.now - facts.lastActivity) / hour;
  const busy = Boolean(facts.thread?.status && busyStatuses.has(facts.thread.status));
  return facts.kind === "worktree" && !facts.inUse && !facts.dirty && facts.unreferenced === 0 && !busy && !facts.thread?.pending && idle >= idleWindow(facts, options);
}

const installLockfiles = new Set(["pnpm-lock.yaml", "bun.lock", "bun.lockb"]);
const toolOutput = ["convex/_generated/", ".coherence/runs/", ".preview-sandbox/"];
const inToolOutput = (path: string) => toolOutput.some((directory) => path.startsWith(directory) || path.includes(`/${directory}`));

export function onlyDisposable(status: string, isSymlink: (path: string) => boolean): boolean {
  return status.split("\0").filter(Boolean).every((entry) => {
    if (/^[RC]/.test(entry)) return false;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === "??") return isSymlink(path) || inToolOutput(path);
    return /^[ M]M$|^M $/.test(code) && (installLockfiles.has(basename(path)) || inToolOutput(path));
  });
}

const isSymlink = (path: string) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };

function uncommitted(path: string): { dirty: boolean; disposable: boolean } {
  const status = Bun.spawnSync(["git", "--no-optional-locks", "-C", path, "status", "--porcelain", "-z", "--untracked-files=normal"], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const out = status.stdout.toString();
  if (status.exitCode !== 0) return { dirty: true, disposable: false };
  return { dirty: out.length > 0, disposable: onlyDisposable(out, (entry) => isSymlink(join(path, entry))) };
}

function closedAs(thread: Thread): string | null {
  return thread.deleted ? "deleted" : thread.archived ? "archived" : thread.settled ? "settled" : null;
}

function run(command: string[], cwd?: string, timeout = 60_000): { ok: boolean; out: string } {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe", timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim() };
}
const git = (cwd: string, ...args: string[]) => run(["git", "--no-optional-locks", "-C", cwd, ...args]);
const mtime = (path: string) => { try { return statSync(path).mtimeMs; } catch { return 0; } };
const isDirectory = (path: string) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
const children = (path: string) => isDirectory(path) ? readdirSync(path).map((name) => join(path, name)).filter(isDirectory) : [];

export type T3State = { ok: boolean; threads: Map<string, Thread>; projects: string[] };

type StateRow = {
  path: string; archived: string | null; deleted: string | null; created: string; override: string | null; settled: string | null; messaged: string | null; pending: number; status: string | null; turned: string | null;
};

export function t3StatePath(userdata: string): string {
  const current = join(userdata, "statev2.sqlite");
  return existsSync(current) ? current : join(userdata, "state.sqlite");
}

function hasTable(db: Database, name: string): boolean {
  return Boolean(db.query("select 1 from sqlite_master where type = 'table' and name = ?").get(name));
}

function orchestrationRows(db: Database): StateRow[] {
  return db.query(`select json_extract(t.payload_json, '$.worktreePath') path, t.archived_at archived, t.deleted_at deleted, t.created_at created,
      json_extract(t.payload_json, '$.settledOverride') override, json_extract(t.payload_json, '$.settledAt') settled,
      (select max(m.created_at) from orchestration_v2_projection_messages m where m.thread_id = t.thread_id and m.role = 'user') messaged,
      (select count(*) from orchestration_v2_projection_runtime_requests q where q.thread_id = t.thread_id and q.resolved_at is null) pending,
      (select r.status from orchestration_v2_projection_runs r where r.thread_id = t.thread_id
        order by case r.status when 'running' then 0 when 'starting' then 1 when 'preparing' then 2 when 'queued' then 3 else 4 end, r.ordinal desc limit 1) status,
      (select max(coalesce(r.completed_at, r.requested_at)) from orchestration_v2_projection_runs r where r.thread_id = t.thread_id) turned
    from orchestration_v2_projection_threads t where json_extract(t.payload_json, '$.worktreePath') is not null`).all() as StateRow[];
}

function legacyRows(db: Database): StateRow[] {
  const columns = new Set((db.query("pragma table_info(projection_threads)").all() as Array<{ name: string }>).map((column) => column.name));
  const settle = columns.has("settled_override") ? "t.settled_override override, t.settled_at settled" : "null override, null settled";
  return db.query(`select t.worktree_path path, t.archived_at archived, t.deleted_at deleted, t.created_at created,
      ${settle},
      t.latest_user_message_at messaged, t.pending_approval_count + t.pending_user_input_count pending, s.status status,
      (select max(coalesce(completed_at, started_at, requested_at)) from projection_turns u where u.thread_id = t.thread_id) turned
    from projection_threads t left join projection_thread_sessions s using (thread_id) where t.worktree_path is not null`).all() as StateRow[];
}

export function readState(statePath: string): T3State {
  const state: T3State = { ok: true, threads: new Map(), projects: [] };
  if (!existsSync(statePath)) return state;
  let db: Database | undefined;
  try {
    db = new Database(statePath, { readonly: true });
    const rows = hasTable(db, "orchestration_v2_projection_threads") ? orchestrationRows(db) : legacyRows(db);
    for (const row of rows) {
      const thread: Thread = {
        status: row.status, archived: Boolean(row.archived), deleted: Boolean(row.deleted), pending: row.pending > 0,
        settled: row.override !== "active" && (row.override === "settled" || row.settled !== null),
        activeAt: Math.max(...[row.created, row.messaged, row.turned].map((value) => Date.parse(value ?? "") || 0)),
      };
      const key = resolve(row.path);
      const previous = state.threads.get(key);
      const open = (item: Thread) => !closedAs(item);
      if (!previous || (open(thread) && !open(previous)) || (open(thread) === open(previous) && thread.activeAt > previous.activeAt)) state.threads.set(key, thread);
    }
    if (hasTable(db, "projection_projects")) state.projects = (db.query("select workspace_root root from projection_projects where deleted_at is null").all() as Array<{ root: string }>).map((row) => resolve(row.root));
  } catch {
    return { ok: false, threads: new Map(), projects: [] };
  } finally { db?.close(); }
  return state;
}

function processDirectories(): string[] {
  if (process.platform === "darwin") return cwdsFromLsof(run(["/usr/sbin/lsof", "-a", "-d", "cwd", "-u", String(process.getuid?.() ?? ""), "-Fn", "-w"]).out);
  const directories: string[] = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try { directories.push(readlinkSync(`/proc/${pid}/cwd`)); } catch {}
  }
  return directories;
}

export function cwdsFromLsof(output: string): string[] {
  const directories = output.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  if (!directories.length) throw new Error("lsof listed no running processes, so prune cannot tell which worktrees are in use");
  return directories;
}

export function removeTreeCommand(path: string, platform: string = process.platform): string[] {
  return platform === "darwin" ? ["rm", "-rfx", path] : ["rm", "-rf", "--one-file-system", path];
}

const inside = (path: string, directories: string[]) => directories.some((directory) => directory === path || directory.startsWith(`${path}/`));

export type Sightings = Record<string, number>;
const sightingsKeepMs = 48 * hour;

export function readSightings(path: string): Sightings {
  try {
    const sightings = JSON.parse(readFileSync(path, "utf8"));
    return sightings && typeof sightings === "object" ? sightings : {};
  } catch { return {}; }
}

export function recordSightings(path: string, directories: string[], now: number): void {
  const sightings = Object.fromEntries(Object.entries(readSightings(path)).filter(([, seen]) => now - seen < sightingsKeepMs));
  for (const directory of directories) sightings[directory] = now;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(sightings));
    renameSync(`${path}.tmp`, path);
  } catch {
  }
}

const lastSeenInside = (path: string, sightings: Sightings) =>
  Math.max(0, ...Object.entries(sightings).filter(([directory]) => inside(path, [directory])).map(([, seen]) => seen));

function defaultBranch(common: string): string | null {
  const head = run(["git", "-C", common, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.out) return head.out;
  for (const candidate of ["origin/main", "origin/master"]) if (run(["git", "-C", common, "rev-parse", "--verify", "--quiet", candidate]).ok) return candidate;
  return null;
}

function owner(path: string): string | null {
  if (!existsSync(join(path, ".git"))) return null;
  const common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common.ok ? dirname(common.out) : null;
}

export function listCandidates(worktreeRoot: string, projects: string[], repos: string[] = []): string[] {
  const paths = new Set<string>();
  const owners = new Set([...projects, ...repos].map((repo) => resolve(repo)).filter(isDirectory));
  for (const project of children(worktreeRoot)) {
    for (const path of children(project)) {
      paths.add(path);
      const repo = owner(path);
      if (repo) owners.add(repo);
    }
  }
  for (const repo of owners) {
    const list = git(repo, "worktree", "list", "--porcelain");
    if (!list.ok) continue;
    const listed = list.out.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => resolve(line.slice("worktree ".length)));
    for (const path of listed.slice(1)) if (isDirectory(path)) paths.add(path);
    for (const path of children(join(repo, ".claude/worktrees"))) paths.add(path);
  }
  return [...paths].sort();
}

type Processes = { running: string[]; seen: Sightings };

function gather(path: string, state: T3State, managed: boolean, processes: Processes, branches: Map<string, string | null>, options: PruneOptions): Facts {
  const thread = state.threads.get(path) ?? null;
  const base: Facts = {
    path, kind: "orphan", dirty: false, disposable: false, branch: null, unreferenced: 0, landed: false, defaultBranch: null, prMerged: false,
    inUse: inside(path, processes.running), lastActivity: Math.max(mtime(path), thread?.activeAt ?? 0, lastSeenInside(path, processes.seen)),
    thread, stateUnknown: managed && !state.ok,
    agent: /\/\.claude\/worktrees\/agent-[^/]+$/.test(path),
  };
  const gitDir = git(path, "rev-parse", "--path-format=absolute", "--git-dir");
  const commonDir = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!existsSync(join(path, ".git"))) return base;
  if (!gitDir.ok || !commonDir.ok || !resolve(gitDir.out).startsWith(resolve(commonDir.out))) return { ...base, kind: "broken" };
  if (resolve(gitDir.out) === resolve(commonDir.out)) return { ...base, kind: "main" };
  const common = dirname(commonDir.out);
  const lastActivity = Math.max(base.lastActivity, mtime(join(gitDir.out, "HEAD")), mtime(join(gitDir.out, "logs/HEAD")));
  if (!branches.has(common)) {
    const name = defaultBranch(common);
    if (name && options.fetch) run(["git", "-C", common, "fetch", "--quiet", "--no-tags", "origin", name.replace(/^origin\//, "")], undefined, 180_000);
    branches.set(common, name);
  }
  const target = branches.get(common) ?? null;
  const branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD");
  const facts: Facts = { ...base, kind: "worktree", lastActivity, branch: branch.ok ? branch.out : null, defaultBranch: target };
  Object.assign(facts, uncommitted(path));
  if (!facts.branch) {
    const loose = git(path, "rev-list", "--count", "HEAD", "--not", "--branches", "--tags", "--remotes");
    facts.unreferenced = loose.ok ? Number(loose.out) : Number.POSITIVE_INFINITY;
  }
  if (target) {
    const cherry = git(path, "cherry", target, "HEAD");
    facts.landed = git(path, "merge-base", "--is-ancestor", "HEAD", target).ok || (cherry.ok && !cherry.out.split("\n").some((line) => line.startsWith("+")));
  }
  if (!facts.landed && facts.branch && Bun.which("gh")) {
    const pr = run(["gh", "pr", "list", "--head", facts.branch, "--state", "merged", "--json", "number", "--jq", "length"], path, 30_000);
    facts.prMerged = pr.ok && Number(pr.out) > 0;
  }
  return facts;
}

function removeDirectory(facts: Facts): { ok: boolean; error?: string } {
  run(["find", facts.path, "-xdev", "-type", "d", "!", "-perm", "-u+w", "-exec", "chmod", "u+w", "{}", "+"], undefined, 600_000);
  if (facts.kind === "worktree") {
    const common = dirname(git(facts.path, "rev-parse", "--path-format=absolute", "--git-common-dir").out);
    const force = facts.dirty;
    if (force && !uncommitted(facts.path).disposable) return { ok: false, error: "new uncommitted changes" };
    const removed = Bun.spawnSync(["git", "-C", common, "worktree", "remove", ...(force ? ["--force"] : []), facts.path], { stderr: "pipe", timeout: 600_000 });
    if (removed.exitCode !== 0) return { ok: false, error: removed.stderr.toString().trim() };
    return { ok: true };
  }
  const removed = run(removeTreeCommand(facts.path), undefined, 600_000);
  return removed.ok ? { ok: true } : { ok: false, error: "rm failed" };
}

function removeIfDecided(facts: Facts, verdict: Verdict, options: PruneOptions): Verdict {
  if (!verdict.remove || options.dryRun) return verdict;
  if (inside(facts.path, processDirectories())) return { ...verdict, remove: false, reason: "a process started inside it" };
  const result = removeDirectory(facts);
  return result.ok ? verdict : { ...verdict, remove: false, reason: `removal failed: ${result.error}` };
}

const device = (path: string) => { try { return statSync(path).dev; } catch { return -1; } };

function evict(kept: Facts[], target: NonNullable<PruneOptions["evict"]>, options: PruneOptions, refresh: (path: string) => Facts): Verdict[] {
  const evicted: Verdict[] = [];
  const pressured = device(options.worktreeRoot);
  const candidates = kept.filter((facts) => evictable(facts, options) && device(facts.path) === pressured).sort((a, b) => a.lastActivity - b.lastActivity);
  const reason = (facts: Facts) => `disk is low; idle ${((options.now - facts.lastActivity) / hour).toFixed(1)}h; commits stay on ${facts.branch ?? "other refs"}`;
  if (options.dryRun) {
    for (const facts of candidates) options.log(`would evict while below ${target.targetGigabytes}G free: ${facts.path} (${reason(facts)})`);
    return [];
  }
  for (const facts of candidates) {
    if (target.free() >= target.targetGigabytes * gigabyte) break;
    const current = refresh(facts.path);
    if (!evictable(current, options)) continue;
    const verdict = removeIfDecided(current, { path: current.path, remove: true, reason: reason(current) }, options);
    options.log(`${verdict.remove ? "evicted" : "kept"}: ${facts.path} (${verdict.reason})`);
    if (verdict.remove) evicted.push(verdict);
  }
  return evicted;
}

const describeFree = (path: string) => `${(freeBytes(path) / gigabyte).toFixed(1)}G free`;

export function prune(options: PruneOptions): Verdict[] {
  const state = readState(options.statePath);
  const branches = new Map<string, string | null>();
  const verdicts: Verdict[] = [];
  const kept = new Map<string, Facts>();
  const seen = readSightings(options.sightingsPath);
  options.log(`Prune ${options.dryRun ? "preview" : "pass"}, idle ${options.minIdleHours}h: ${describeFree(options.worktreeRoot)}`);
  if (!state.ok) options.log(`Cannot read ${options.statePath}. Keeping every T3 worktree${options.evict ? " except clean ones the disk pressure evicts" : ""}.`);
  const root = resolve(options.worktreeRoot);
  for (const path of listCandidates(root, state.projects, options.repos)) {
    const managed = path.startsWith(`${root}/`);
    const facts = gather(path, state, managed, { running: processDirectories(), seen }, branches, options);
    const verdict = removeIfDecided(facts, decide(facts, options), options);
    if (!verdict.remove) kept.set(path, facts);
    verdicts.push(verdict);
    options.log(`${verdict.remove ? (options.dryRun ? "would remove" : "removed") : "kept"}: ${path} (${verdict.reason})`);
  }
  const refresh = (path: string) => gather(path, state, path.startsWith(`${root}/`), { running: processDirectories(), seen }, branches, { ...options, fetch: false });
  if (options.evict) for (const verdict of evict([...kept.values()], options.evict, options, refresh)) verdicts[verdicts.findIndex((item) => item.path === verdict.path)] = verdict;
  for (const common of branches.keys()) if (!options.dryRun) run(["git", "-C", common, "worktree", "prune"]);
  options.log(`Done: ${verdicts.filter((verdict) => verdict.remove).length} removed, ${verdicts.filter((verdict) => !verdict.remove).length} kept. ${describeFree(options.worktreeRoot)}`);
  return verdicts;
}

export type CacheHost = {
  platform: string;
  has: (command: string) => boolean;
  run: (command: string[], timeout?: number) => { ok: boolean; out: string };
  isDirectory: (path: string) => boolean;
  free: (path: string) => string;
};

const systemHost: CacheHost = {
  platform: process.platform,
  has: (command) => Boolean(Bun.which(command)),
  run: (command, timeout) => run(command, undefined, timeout),
  isDirectory,
  free: describeFree,
};

export function reclaimCaches(home: string, mode: Pressure, auto: AutoOptions, log: (line: string) => void, host: CacheHost = systemHost): void {
  if (mode !== "normal" && host.has("nix-store")) {
    const gc = host.run(["nix-store", "--gc"], 1_800_000);
    log(`nix-store --gc: ${gc.ok ? "done" : "failed"}. ${host.free(home)}`);
  }
  if (mode !== "normal" && host.has("pnpm")) {
    const prune = host.run(["pnpm", "store", "prune"], 1_800_000);
    log(`pnpm store prune: ${prune.ok ? "done" : "failed"}. ${host.free(home)}`);
  }
  clearCache(host, log, home, {
    path: join(home, ".cargo/target"), limit: mode === "critical" ? 0 : auto.cargoTargetGigabytes * gigabyte,
    processes: "cargo|rustc", busy: "a Rust build runs", what: "Rust build output",
  });
  if (mode !== "normal") clearCache(host, log, home, {
    path: join(home, ".cache/uv"), limit: mode === "critical" ? 0 : auto.uvCacheGigabytes * gigabyte,
    processes: "uv", busy: "a uv process runs", what: "uv download cache",
  });
}

type Cache = { path: string; limit: number; processes: string; busy: string; what: string };

function clearCache(host: CacheHost, log: (line: string) => void, home: string, cache: Cache): void {
  if (!host.isDirectory(cache.path)) return;
  const size = Number(host.run(["du", "-sxk", cache.path], 600_000).out.split("\t")[0]) * 1024;
  if (!(size > cache.limit)) return;
  const shown = `${(size / gigabyte).toFixed(1)}G`;
  const running = host.run(["pgrep", "-u", String(process.getuid?.() ?? ""), "-x", cache.processes]).out;
  if (running) { log(`kept: ${cache.path} (${shown}; ${cache.busy})`); return; }
  host.run(removeTreeCommand(cache.path, host.platform), 1_800_000);
  log(`removed: ${cache.path} (${shown} of ${cache.what}). ${host.free(home)}`);
}

export function trimLog(path: string, limitBytes: number, keepBytes: number, log: (line: string) => void): void {
  let stats: { size: number; blksize: number };
  try { stats = statSync(path); } catch { return; }
  if (stats.size <= limitBytes) return;
  const head = Math.floor((stats.size - keepBytes) / stats.blksize) * stats.blksize;
  const collapsed = run(["fallocate", "--collapse-range", "--offset", "0", "--length", String(head), path]);
  log(collapsed.ok ? `trimmed: ${path} (removed the first ${head} of ${stats.size} bytes)` : `kept: ${path} (${stats.size} bytes; fallocate cannot collapse it)`);
}

export type Consumer = { path: string; bytes: number };

export function largestConsumers(roots: Array<{ path: string; depth: number }>, count: number): { consumers: Consumer[]; complete: boolean } {
  const consumers: Consumer[] = [];
  let complete = true;
  for (const root of roots) {
    const du = Bun.spawnSync([...(Bun.which("ionice") ? ["ionice", "-c3"] : []), "du", "-xk", "-d", String(root.depth), root.path], { stdout: "pipe", stderr: "ignore", timeout: 300_000 });
    if (du.exitCode !== 0) complete = false;
    for (const line of du.stdout.toString().split("\n")) {
      const [kilobytes, path] = line.split("\t");
      const below = path ? relative(root.path, path) : "";
      if (!below || below.split("/").length !== root.depth) continue;
      consumers.push({ path, bytes: Number(kilobytes) * 1024 });
    }
  }
  return { consumers: consumers.sort((a, b) => b.bytes - a.bytes).slice(0, count), complete };
}

const freshT3VersionMs = 86_400_000;

export function reclaimT3Versions(t3Home: string, cli: string, now: number, log: (line: string) => void): void {
  const versions = join(t3Home, "runtime/versions");
  const inUse = t3VersionsInUse(t3Home, cli);
  if (!inUse || !isDirectory(versions)) return;
  for (const version of readdirSync(versions)) {
    const path = join(versions, version);
    if (inUse.has(version) || now - statSync(path).mtimeMs < freshT3VersionMs) continue;
    rmSync(path, { recursive: true, force: true });
    log(`removed: ${path} (old T3 version)`);
  }
}

function t3VersionsInUse(t3Home: string, cli: string): Set<string> | null {
  let state: { activeVersion?: unknown; update?: { fromVersion?: unknown; targetVersion?: unknown } };
  try { state = JSON.parse(readFileSync(join(t3Home, "runtime/service-state.json"), "utf8")); } catch { return null; }
  if (typeof state.activeVersion !== "string") return null;
  const inUse = new Set([state.activeVersion, state.update?.fromVersion, state.update?.targetVersion].filter((version) => typeof version === "string"));
  try { inUse.add(basename(dirname(realpathSync(cli)))); } catch {}
  return inUse;
}

export type AutoOptions = {
  lowFreeGigabytes: number; criticalFreeGigabytes: number;
  targetFreeGigabytes: number;
  intervalMinutes: number;
  lowIntervalMinutes: number;
  cargoTargetGigabytes: number;
  uvCacheGigabytes: number;
  stampPath: string;
};

export type Pressure = "normal" | "low" | "critical";

export function pressure(free: number, auto: AutoOptions): Pressure {
  if (free < auto.criticalFreeGigabytes * gigabyte) return "critical";
  return free < auto.lowFreeGigabytes * gigabyte ? "low" : "normal";
}

export function autoMode(free: number, lastPass: number, now: number, auto: AutoOptions): "skip" | Pressure {
  const level = pressure(free, auto);
  const interval = { critical: 0, low: auto.lowIntervalMinutes, normal: auto.intervalMinutes }[level];
  return now - lastPass >= interval * 60_000 ? level : "skip";
}

export function pruneAuto(options: PruneOptions, auto: AutoOptions, home: string): Verdict[] {
  recordSightings(options.sightingsPath, processDirectories(), options.now);
  const lastPass = (() => { try { return Number(readFileSync(auto.stampPath, "utf8")) || 0; } catch { return 0; } })();
  const mode = autoMode(freeBytes(options.worktreeRoot), lastPass, options.now, auto);
  if (mode === "skip") return [];
  if (mode !== "normal") options.log(`Disk pressure (${mode}): ${describeFree(options.worktreeRoot)}. Idle window 1h.`);
  const evict = { targetGigabytes: auto.targetFreeGigabytes, free: () => freeBytes(options.worktreeRoot) };
  const pressured = mode === "normal" ? options : { ...options, minIdleHours: 1, unownedIdleHours: 6, agentIdleHours: 6, evict };
  const verdicts = prune(pressured);
  if (!options.dryRun) {
    trimLog(join(home, ".t3/userdata/logs/boot-service.log"), 100 * 1024 ** 2, 20 * 1024 ** 2, options.log);
    reclaimCaches(home, pressure(freeBytes(options.worktreeRoot), auto), auto, options.log);
    reclaimT3Versions(join(home, ".t3"), join(home, ".local/bin/t3"), options.now, options.log);
  }
  if (mode !== "normal" && freeBytes(options.worktreeRoot) < auto.lowFreeGigabytes * gigabyte) logConsumers(home, options.log);
  if (!options.dryRun) writeStamp(auto.stampPath, options.now, options.log);
  return verdicts;
}

function writeStamp(path: string, now: number, log: (line: string) => void): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(now));
  } catch (error) { log(`Cannot write ${path}: ${(error as Error).message}`); }
}

function logConsumers(home: string, log: (line: string) => void): void {
  const { consumers, complete } = largestConsumers([{ path: home, depth: 2 }, { path: tmpdir(), depth: 1 }], 6);
  const shown = consumers.map((consumer) => `${consumer.path.replace(home, "~")} ${(consumer.bytes / gigabyte).toFixed(1)}G`);
  log(`Still ${describeFree(home)}. Largest${complete ? "" : " (du did not finish or could not read everything, totals may be short)"}: ${shown.join(", ")}.`);
}

export type PruneContext = { home: string; env: Record<string, string | undefined>; floorGigabytes: number };

export function pruneOptions(args: string[], log: (line: string) => void, { home, env, floorGigabytes }: PruneContext): { options: PruneOptions; auto: AutoOptions | null } {
  const state = join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "fleet");
  const options: PruneOptions = {
    worktreeRoot: join(home, ".t3/worktrees"), statePath: t3StatePath(join(home, ".t3/userdata")), now: Date.now(),
    repos: [], minIdleHours: 6, unownedIdleHours: 24, agentIdleHours: 24, dryRun: false, fetch: true, log,
    sightingsPath: join(state, "worktree-sightings.json"),
  };
  let auto: AutoOptions | null = null;
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "--no-fetch") { options.fetch = false; continue; }
    if (arg === "--auto") { auto = autoOptions(floorGigabytes, join(state, "worktree-prune.last")); continue; }
    if (["--root", "--state", "--repo", "--min-idle-hours"].includes(arg)) {
      const value = args.shift();
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--root") options.worktreeRoot = resolve(value);
      if (arg === "--state") options.statePath = resolve(value);
      if (arg === "--repo") options.repos.push(resolve(value));
      if (arg === "--min-idle-hours") {
        options.minIdleHours = Number(value);
        if (!Number.isFinite(options.minIdleHours) || options.minIdleHours < 1) throw new Error("--min-idle-hours must be 1 or more");
      }
      continue;
    }
    throw new Error(`Unknown prune argument: ${arg}`);
  }
  return { options, auto };
}

function autoOptions(floorGigabytes: number, stampPath: string): AutoOptions {
  return {
    criticalFreeGigabytes: floorGigabytes, lowFreeGigabytes: floorGigabytes + 15, targetFreeGigabytes: floorGigabytes + 30,
    intervalMinutes: 60, lowIntervalMinutes: 10, cargoTargetGigabytes: 20, uvCacheGigabytes: 5, stampPath,
  };
}
