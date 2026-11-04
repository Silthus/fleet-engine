import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type AutoOptions, type CacheHost, cwdsFromLsof, decide, evictable, onlyDisposable, prune, pruneOptions, readSightings, readState, reclaimCaches, reclaimT3Versions, recordSightings, removeTreeCommand, t3StatePath, type Facts } from "./prune.ts";

const onLinux = test.skipIf(process.platform !== "linux");
const noMergedPullRequests = () => false;

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const now = Date.parse("2026-09-25T12:00:00Z");
const limits = { now, minIdleHours: 6, unownedIdleHours: 24, agentIdleHours: 24 };
const idle: Facts = {
  path: "/w/p/a", kind: "worktree", dirty: false, disposable: false, branch: "feature", unreferenced: 0, landed: true, defaultBranch: "origin/main",
  prMerged: false, inUse: false, lastActivity: now - 48 * 3600_000, thread: null, stateUnknown: false, agent: false,
};

test("removes an idle, clean worktree whose commits landed", () => {
  expect(decide(idle, limits)).toEqual({ path: "/w/p/a", remove: true, reason: "all commits are on origin/main" });
});

test("keeps work that is active, dirty, unmerged, or held only by the worktree", () => {
  const thread = { status: "stopped", archived: false, deleted: false, settled: false, pending: false, activeAt: 0 };
  const cases: Array<[Partial<Facts>, string]> = [
    [{ kind: "main" }, "primary checkout"],
    [{ inUse: true }, "a process runs inside it"],
    [{ thread: { ...thread, status: "running" } }, "T3 session is running"],
    [{ thread: { ...thread, pending: true } }, "T3 thread waits for an answer"],
    [{ lastActivity: now - 2 * 3600_000 }, "active 2.0h ago"],
    [{ dirty: true }, "uncommitted changes"],
    [{ branch: null, unreferenced: 3 }, "3 commits exist only in this worktree"],
    [{ landed: false }, "unmerged work"],
    [{ kind: "orphan", thread }, "Git does not track it, but its T3 thread is open"],
    [{ kind: "orphan", lastActivity: now - 12 * 3600_000 }, "Git does not track it; active 12.0h ago"],
    [{ kind: "broken", dirty: false }, "Git cannot read its worktree metadata"],
  ];
  for (const [change, reason] of cases) expect(decide({ ...idle, ...change }, limits)).toEqual({ path: idle.path, remove: false, reason });
});

test("removes a worktree of a closed thread whose only changes are ones tools make, and keeps it while the thread is open", () => {
  const settled = { status: "completed", archived: false, deleted: false, settled: true, pending: false, activeAt: 0 };
  const touched = { ...idle, landed: false, dirty: true, disposable: true };
  expect(decide({ ...touched, thread: settled }, limits)).toMatchObject({ remove: true, reason: "T3 thread is settled; commits stay on feature; drops lockfile and tool output changes" });
  expect(decide({ ...touched, thread: { ...settled, settled: false } }, limits).reason).toBe("uncommitted changes");
  expect(decide({ ...touched, thread: settled, disposable: false }, limits).reason).toBe("uncommitted changes");
});

test("counts only lockfiles, symlinks, generated Convex code, and tool run output as disposable", () => {
  const symlinks = new Set(["node_modules"]);
  const disposable = (...entries: string[]) => onlyDisposable(entries.map((entry) => `${entry}\0`).join(""), (path) => symlinks.has(path));
  expect(disposable(" M pnpm-lock.yaml", "M  bun.lock", "?? node_modules", "?? .coherence/runs/a.jsonl", "?? .preview-sandbox/", " M convex/_generated/api.d.ts")).toBe(true);
  expect(disposable(" M pnpm-lock.yaml", " M package.json")).toBe(false);
  expect(disposable("?? notes.md")).toBe(false);
  expect(disposable("?? .coherence/")).toBe(false);
  expect(disposable(" D pnpm-lock.yaml")).toBe(false);
  expect(disposable("R  pnpm-lock.yaml", "src/lock.ts")).toBe(false);
});

const sh = (cwd: string, ...command: string[]) => expect(Bun.spawnSync(command, { cwd, stderr: "pipe" }).exitCode).toBe(0);
const commit = (cwd: string, message: string) => sh(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", message);

/** A repository whose main branch is also origin/main, with an empty T3 worktree root next to it. */
async function repository(): Promise<{ base: string; repo: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "fleet-prune-"));
  temporary.push(base);
  const repo = join(base, "repo");
  await mkdir(repo);
  sh(repo, "git", "init", "-q", "-b", "main");
  await writeFile(join(repo, "pnpm-lock.yaml"), "a\n");
  await writeFile(join(repo, "app.ts"), "a\n");
  sh(repo, "git", "add", ".");
  commit(repo, "init");
  sh(repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD");
  return { base, repo, root: join(base, "worktrees") };
}

/** A T3 state database with one thread per worktree, created on 2026-09-20. */
function t3State(path: string, threads: Array<{ worktreePath: string; settledAt?: string }>): string {
  const db = new Database(path);
  db.run("create table orchestration_v2_projection_threads (thread_id text, created_at text, archived_at text, deleted_at text, payload_json text)");
  db.run("create table orchestration_v2_projection_runs (run_id text, thread_id text, ordinal integer, status text, requested_at text, completed_at text)");
  db.run("create table orchestration_v2_projection_messages (message_id text, thread_id text, role text, created_at text)");
  db.run("create table orchestration_v2_projection_runtime_requests (runtime_request_id text, thread_id text, created_at text, resolved_at text)");
  for (const thread of threads) db.run("insert into orchestration_v2_projection_threads values (?, '2026-09-20T00:00:00Z', null, null, ?)", [thread.worktreePath, JSON.stringify(thread)]);
  db.close();
  return path;
}

onLinux("a prune pass removes a settled worktree that has only tool changes and keeps one with a real edit", async () => {
  const { base, repo, root } = await repository();
  const tooled = join(root, "repo/tooled");
  const edited = join(root, "repo/edited");
  for (const [path, branch] of [[tooled, "tooled"], [edited, "edited"]]) sh(repo, "git", "worktree", "add", "-q", "-b", branch, path);
  const shared = join(base, "shared-node-modules");
  await mkdir(shared);
  await writeFile(join(shared, "kept"), "");
  await symlink(shared, join(tooled, "node_modules"));
  await writeFile(join(tooled, "pnpm-lock.yaml"), "b\n");
  await writeFile(join(edited, "app.ts"), "b\n");

  const statePath = t3State(join(base, "statev2.sqlite"), [tooled, edited].map((worktreePath) => ({ worktreePath, settledAt: "2026-09-21T00:00:00Z" })));

  const verdicts = prune({
    worktreeRoot: root, statePath, now: Date.now() + 48 * 3600_000, repos: [], minIdleHours: 6, unownedIdleHours: 24, agentIdleHours: 24,
    dryRun: false, fetch: false, log: () => {}, sightingsPath: join(base, "sightings.json"), mergedPullRequest: noMergedPullRequests,
  });

  expect(verdicts.find((verdict) => verdict.path === tooled)?.remove).toBe(true);
  expect(verdicts.find((verdict) => verdict.path === edited)).toMatchObject({ remove: false, reason: "uncommitted changes" });
  expect(await readdir(join(root, "repo"))).toEqual(["edited"]);
  expect(await readdir(shared)).toEqual(["kept"]);
});

test("removes an idle agent worktree with unmerged commits on a branch, and keeps unreadable T3 state", () => {
  const agent = { ...idle, path: "/r/.claude/worktrees/agent-a1", agent: true, landed: false };
  expect(decide(agent, limits)).toMatchObject({ remove: true, reason: "agent worktree idle 48.0h; commits stay on feature" });
  expect(decide({ ...agent, lastActivity: now - 12 * 3600_000 }, limits).reason).toBe("unmerged work");
  expect(decide({ ...agent, dirty: true }, limits).reason).toBe("uncommitted changes");
  expect(decide({ ...idle, stateUnknown: true }, limits).reason).toBe("T3 state is unreadable");
});

test("under disk pressure, evicts a clean worktree whose commits a ref keeps, even with an open thread or unreadable state", () => {
  const open = { status: "completed", archived: false, deleted: false, settled: false, pending: false, activeAt: 0 };
  const pressure = { ...limits, minIdleHours: 1 };
  const unmerged = { ...idle, landed: false, thread: open };
  expect(evictable(unmerged, pressure)).toBe(true);
  expect(evictable({ ...unmerged, thread: null, stateUnknown: true }, pressure)).toBe(true);
  const kept: Array<Partial<Facts>> = [
    { kind: "main" }, { kind: "orphan" }, { inUse: true }, { dirty: true }, { branch: null, unreferenced: 2 },
    { thread: { ...open, status: "running" } }, { thread: { ...open, pending: true } }, { lastActivity: now - 30 * 60_000 },
  ];
  for (const change of kept) expect(evictable({ ...unmerged, ...change }, pressure)).toBe(false);
});

test("under disk pressure, keeps a worktree that no thread or agent owns for the longer unowned window", () => {
  const pressure = { ...limits, minIdleHours: 1, unownedIdleHours: 6 };
  const detached = { ...idle, path: "/tmp/eval/new", branch: null, landed: false, lastActivity: now - 3 * 3600_000 };
  expect(evictable(detached, pressure)).toBe(false);
  expect(decide({ ...detached, landed: true }, pressure).reason).toBe("no T3 thread or agent owns it; active 3.0h ago");
  expect(evictable({ ...detached, lastActivity: now - 7 * 3600_000 }, pressure)).toBe(true);
  const open = { status: "completed", archived: false, deleted: false, settled: false, pending: false, activeAt: 0 };
  expect(evictable({ ...detached, thread: open }, pressure)).toBe(true);
});

onLinux("under disk pressure, a prune pass evicts an idle worktree and keeps one where a process ran since the last pass", async () => {
  const { base, repo, root } = await repository();
  const used = join(root, "repo/used");
  const unused = join(root, "repo/unused");
  for (const path of [used, unused]) {
    sh(repo, "git", "worktree", "add", "-q", "-b", basename(path), path);
    await writeFile(join(path, "app.ts"), "b\n");
    commit(path, "work");
  }
  const later = Date.now() + 3 * 3600_000;
  const sightingsPath = join(base, "sightings.json");
  recordSightings(sightingsPath, [join(used, "frontend")], later - 30 * 60_000);

  const verdicts = prune({
    worktreeRoot: root, statePath: t3State(join(base, "statev2.sqlite"), [{ worktreePath: used }, { worktreePath: unused }]), now: later, repos: [],
    minIdleHours: 1, unownedIdleHours: 6, agentIdleHours: 6, dryRun: false, fetch: false, log: () => {}, sightingsPath,
    evict: { targetGigabytes: 1, free: () => 0 }, mergedPullRequest: noMergedPullRequests,
  });

  expect(verdicts.find((verdict) => verdict.path === used)).toMatchObject({ remove: false, reason: "active 0.5h ago" });
  expect(verdicts.find((verdict) => verdict.path === unused)?.remove).toBe(true);
  expect(await readdir(join(root, "repo"))).toEqual(["used"]);
});

onLinux("removes a worktree whose branch has a merged pull request, asking the lookup it was given", async () => {
  const { base, repo, root } = await repository();
  const merged = join(root, "repo/merged");
  sh(repo, "git", "worktree", "add", "-q", "-b", "merged", merged);
  await writeFile(join(merged, "app.ts"), "squashed\n");
  commit(merged, "work");
  const asked: string[] = [];

  const verdicts = prune({
    worktreeRoot: root, statePath: join(base, "missing.sqlite"), now: Date.now() + 72 * 3600_000, repos: [],
    minIdleHours: 6, unownedIdleHours: 24, agentIdleHours: 24, dryRun: true, fetch: false, log: () => {}, sightingsPath: join(base, "sightings.json"),
    mergedPullRequest: (branch) => (asked.push(branch), branch === "merged"),
  });

  expect(asked).toEqual(["merged"]);
  expect(verdicts.find((verdict) => verdict.path === merged)).toMatchObject({ remove: true, reason: "pull request for merged is merged" });
});

onLinux("keeps a worktree whose Git metadata is gone, with its uncommitted work", async () => {
  const { base, repo, root } = await repository();
  const broken = join(root, "repo/broken");
  sh(repo, "git", "worktree", "add", "-q", "-b", "broken", broken);
  await writeFile(join(broken, "notes.md"), "not committed\n");
  await rm(join(repo, ".git/worktrees/broken"), { recursive: true, force: true });

  const verdicts = prune({
    worktreeRoot: root, statePath: join(base, "missing.sqlite"), now: Date.now() + 72 * 3600_000, repos: [],
    minIdleHours: 6, unownedIdleHours: 24, agentIdleHours: 24, dryRun: false, fetch: false, log: () => {}, sightingsPath: join(base, "sightings.json"), mergedPullRequest: noMergedPullRequests,
  });

  expect(verdicts.find((verdict) => verdict.path === broken)).toMatchObject({ remove: false, reason: "Git cannot read its worktree metadata" });
  expect(await readdir(broken)).toContain("notes.md");
});

test("records where processes run and forgets sightings older than two days", async () => {
  const base = await mkdtemp(join(tmpdir(), "fleet-sightings-"));
  temporary.push(base);
  const path = join(base, "state/sightings.json");
  recordSightings(path, ["/old"], now - 49 * 3600_000);
  recordSightings(path, ["/recent"], now - 3600_000);
  recordSightings(path, ["/now"], now);
  expect(readSightings(path)).toEqual({ "/recent": now - 3600_000, "/now": now });
});

test("reads the live orchestration v2 state of a nightly T3 and ignores its frozen legacy tables", async () => {
  const userdata = await mkdtemp(join(tmpdir(), "fleet-state-v2-"));
  temporary.push(userdata);
  await writeFile(join(userdata, "state.sqlite"), "");
  const state = join(userdata, "statev2.sqlite");
  const db = new Database(state);
  db.run(`create table projection_threads (thread_id text, worktree_path text, archived_at text, deleted_at text, created_at text,
    latest_user_message_at text, pending_approval_count integer, pending_user_input_count integer, settled_override text, settled_at text)`);
  db.run("create table projection_thread_sessions (thread_id text, status text)");
  db.run("create table projection_turns (thread_id text, requested_at text, started_at text, completed_at text)");
  db.run("insert into projection_threads values ('done', '/w/done', null, null, '2026-09-20T00:00:00Z', null, 0, 0, null, null)");
  db.run("insert into projection_thread_sessions values ('done', 'running')");
  db.run("create table orchestration_v2_projection_threads (thread_id text, created_at text, archived_at text, deleted_at text, payload_json text)");
  db.run("create table orchestration_v2_projection_runs (run_id text, thread_id text, ordinal integer, status text, requested_at text, completed_at text)");
  db.run("create table orchestration_v2_projection_messages (message_id text, thread_id text, role text, created_at text)");
  db.run("create table orchestration_v2_projection_runtime_requests (runtime_request_id text, thread_id text, created_at text, resolved_at text)");
  const thread = (id: string, payload: object, archived: string | null = null) =>
    db.run("insert into orchestration_v2_projection_threads values (?, '2026-09-20T00:00:00Z', ?, null, ?)", [id, archived, JSON.stringify({ worktreePath: `/w/${id}`, ...payload })]);
  thread("done", { settledOverride: null, settledAt: "2026-09-24T00:00:00Z" });
  thread("busy", {});
  thread("asking", {});
  thread("archived", {}, "2026-09-23T00:00:00Z");
  db.run("insert into orchestration_v2_projection_runs values ('d1', 'done', 1, 'completed', '2026-09-21T00:00:00Z', '2026-09-22T00:00:00Z')");
  db.run("insert into orchestration_v2_projection_runs values ('b1', 'busy', 1, 'completed', '2026-09-21T00:00:00Z', '2026-09-21T01:00:00Z')");
  db.run("insert into orchestration_v2_projection_runs values ('b2', 'busy', 2, 'running', '2026-09-25T10:00:00Z', null)");
  thread("waiting", {});
  db.run("insert into orchestration_v2_projection_runs values ('w1', 'waiting', 1, 'running', '2026-09-21T00:00:00Z', null)");
  db.run("insert into orchestration_v2_projection_runs values ('w2', 'waiting', 2, 'queued', '2026-09-21T00:05:00Z', null)");
  db.run("insert into orchestration_v2_projection_messages values ('m1', 'asking', 'user', '2026-09-23T00:00:00Z')");
  db.run("insert into orchestration_v2_projection_runtime_requests values ('r1', 'asking', '2026-09-23T00:01:00Z', null)");
  db.close();

  const threads = readState(t3StatePath(userdata)).threads;
  expect(threads.get("/w/done")).toMatchObject({ status: "completed", settled: true, pending: false, activeAt: Date.parse("2026-09-22T00:00:00Z") });
  expect(threads.get("/w/busy")).toMatchObject({ status: "running", settled: false, activeAt: Date.parse("2026-09-25T10:00:00Z") });
  expect(threads.get("/w/asking")).toMatchObject({ pending: true, activeAt: Date.parse("2026-09-23T00:00:00Z") });
  expect(threads.get("/w/archived")).toMatchObject({ archived: true });
  expect(decide({ ...idle, path: "/w/busy", thread: threads.get("/w/busy")! }, limits).reason).toBe("T3 session is running");
  expect(threads.get("/w/waiting")).toMatchObject({ status: "running" });
  const queued = { ...threads.get("/w/busy")!, status: "queued" };
  expect(decide({ ...idle, path: "/w/busy", thread: queued }, limits).reason).toBe("T3 session is queued");
});

test("removes old T3 versions and keeps the active, updating, linked, and recent ones", async () => {
  const t3Home = await mkdtemp(join(tmpdir(), "fleet-t3-versions-"));
  temporary.push(t3Home);
  const versions = join(t3Home, "runtime/versions");
  const old = (now - 3 * 86_400_000) / 1000;
  for (const version of ["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6"]) {
    await mkdir(join(versions, version), { recursive: true });
    await writeFile(join(versions, version, "t3"), "");
    if (version !== "1.0.6") await utimes(join(versions, version), old, old);
  }
  const update = { fromVersion: "1.0.3", targetVersion: "1.0.4", status: "pending" };
  await writeFile(join(t3Home, "runtime/service-state.json"), JSON.stringify({ protocol: 3, activeVersion: "1.0.3", update }));
  const cli = join(t3Home, "t3");
  await symlink(join(versions, "1.0.1/t3"), cli);

  reclaimT3Versions(t3Home, cli, now, () => {});

  expect((await readdir(versions)).sort()).toEqual(["1.0.1", "1.0.3", "1.0.4", "1.0.6"]);
});

test("keeps every T3 version when the service state is unreadable", async () => {
  const t3Home = await mkdtemp(join(tmpdir(), "fleet-t3-versions-"));
  temporary.push(t3Home);
  const versions = join(t3Home, "runtime/versions");
  const old = (now - 3 * 86_400_000) / 1000;
  for (const version of ["1.0.0", "1.0.1"]) {
    await mkdir(join(versions, version), { recursive: true });
    await utimes(join(versions, version), old, old);
  }
  await writeFile(join(t3Home, "runtime/service-state.json"), "{");

  reclaimT3Versions(t3Home, join(t3Home, "t3"), now, () => {});

  expect((await readdir(versions)).sort()).toEqual(["1.0.0", "1.0.1"]);
});

const gigabytes = 1024 ** 3;
const home = "/home/test";
const uvCache = `${home}/.cache/uv`;
const cargoTarget = `${home}/.cargo/target`;
const cacheAuto: AutoOptions = {
  lowFreeGigabytes: 25, criticalFreeGigabytes: 10, targetFreeGigabytes: 40, intervalMinutes: 60, lowIntervalMinutes: 10,
  cargoTargetGigabytes: 20, uvCacheGigabytes: 5, stampPath: "/unused/stamp",
};

/** Fake host: sizes come from `caches` (bytes), and `busy` lists the process patterns that pgrep finds. */
function fakeHost(caches: Record<string, number>, busy: string[] = [], platform = "linux") {
  const ran: string[] = [];
  const host: CacheHost = {
    platform,
    has: () => true,
    run: (command) => {
      ran.push(command.join(" "));
      const last = command.at(-1)!;
      if (command[0] === "du") return { ok: true, out: `${caches[last] / 1024}\t${last}` };
      if (command[0] === "pgrep") return { ok: true, out: busy.includes(last) ? "42" : "" };
      return { ok: true, out: "" };
    },
    isDirectory: (path) => path in caches,
    free: () => "20.0G free",
  };
  return { host, ran };
}

test("under disk pressure, prunes the pnpm store and clears a uv cache past its cap", () => {
  const { host, ran } = fakeHost({ [uvCache]: 6 * gigabytes, [cargoTarget]: gigabytes });
  reclaimCaches(home, "low", cacheAuto, () => {}, host);
  expect(ran).toContain("pnpm store prune");
  expect(ran).toContain(`rm -rf --one-file-system ${uvCache}`);
  expect(ran).not.toContain(`rm -rf --one-file-system ${cargoTarget}`);
});

test("when the disk is critical, clears the uv cache and the Rust build output whatever their size", () => {
  const { host, ran } = fakeHost({ [uvCache]: gigabytes, [cargoTarget]: gigabytes });
  reclaimCaches(home, "critical", cacheAuto, () => {}, host);
  expect(ran).toContain(`rm -rf --one-file-system ${uvCache}`);
  expect(ran).toContain(`rm -rf --one-file-system ${cargoTarget}`);
});

test("when the disk is only low, keeps a uv cache under its cap", () => {
  const { host, ran } = fakeHost({ [uvCache]: 2 * gigabytes });
  reclaimCaches(home, "low", cacheAuto, () => {}, host);
  expect(ran).toContain("pnpm store prune");
  expect(ran).not.toContain(`rm -rf --one-file-system ${uvCache}`);
});

test("on a normal disk, leaves the pnpm store and the uv cache alone", () => {
  const { host, ran } = fakeHost({ [uvCache]: 6 * gigabytes });
  reclaimCaches(home, "normal", cacheAuto, () => {}, host);
  expect(ran).not.toContain("pnpm store prune");
  expect(ran.some((command) => command.includes(uvCache))).toBe(false);
});

test("keeps the uv cache while a uv process runs", () => {
  const { host, ran } = fakeHost({ [uvCache]: 6 * gigabytes }, ["uv"]);
  reclaimCaches(home, "critical", cacheAuto, () => {}, host);
  expect(ran).not.toContain(`rm -rf --one-file-system ${uvCache}`);
});

test("takes the disk floor from settings and keeps the low and target marks above it", () => {
  const { options, auto } = pruneOptions(["--auto"], () => {}, { home: "/home/test", env: {}, floorGigabytes: 12 });
  expect(auto).toMatchObject({ criticalFreeGigabytes: 12, lowFreeGigabytes: 27, targetFreeGigabytes: 42, stampPath: "/home/test/.local/state/fleet/worktree-prune.last" });
  expect(options).toMatchObject({ worktreeRoot: "/home/test/.t3/worktrees", sightingsPath: "/home/test/.local/state/fleet/worktree-sightings.json" });
  expect(pruneOptions([], () => {}, { home: "/home/test", env: { XDG_STATE_HOME: "/state" }, floorGigabytes: 10 }).options.sightingsPath).toBe("/state/fleet/worktree-sightings.json");
});

test("on a Mac, reads the working directories of processes from lsof", () => {
  expect(cwdsFromLsof("p1\nfcwd\nn/Users/me/.t3/worktrees/app/a\np2\nfcwd\nn/\n")).toEqual(["/Users/me/.t3/worktrees/app/a", "/"]);
});

test("on a Mac, stops when lsof lists no process, since prune itself always runs", () => {
  expect(() => cwdsFromLsof("")).toThrow("lsof listed no running processes");
});

test("on a Mac, clears a cache with the rm flag macOS knows", () => {
  const { host, ran } = fakeHost({ [uvCache]: gigabytes }, [], "darwin");
  reclaimCaches(home, "critical", cacheAuto, () => {}, host);
  expect(ran).toContain(`rm -rfx ${uvCache}`);
});

test("removes a tree without leaving its filesystem, with the flag each platform's rm knows", () => {
  expect(removeTreeCommand("/w/a", "linux")).toEqual(["rm", "-rf", "--one-file-system", "/w/a"]);
  expect(removeTreeCommand("/w/a", "darwin")).toEqual(["rm", "-rfx", "/w/a"]);
});

test("a pass on a machine where T3 made no worktrees yet keeps nothing and fails nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "fleet-fresh-"));
  temporary.push(home);
  const lines: string[] = [];
  const { options } = pruneOptions(["--no-fetch"], (line) => lines.push(line), { home, env: {}, floorGigabytes: 10 });
  expect(prune(options)).toEqual([]);
  expect(lines.at(-1)).toMatch(/^Done: 0 removed, 0 kept\. [\d.]+G free$/);
});
