import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export const boxPrefix = "box-";
const idleStopMs = 2 * 3_600_000;
const idleStatuses = new Set(["stopped", "failed", "canceled"]);
const tokenLifetime = "720h";
const tokenRenewWithinMs = 7 * 86_400_000;
const tokenScopes = ["coder:workspaces.create", "coder:workspaces.operate", "coder:workspaces.access", "coder:workspaces.delete", "user:read"];

export type Env = Record<string, string | undefined>;
export type Result = { code: number; stdout: string; stderr: string };
export type Box = { name: string; id: string; template: string; status: string; lastUsedAt: string };
export type Capture = (argv: string[], options: { env?: Env; stdin?: string; timeoutMs: number; inherit?: boolean }) => Promise<Result>;
export type Timer = (ms: number, fire: () => void) => () => void;
export type CoderOptions = { home: string; env: Env; coderUrl: string; template: string; capture?: Capture; fetch?: typeof fetch };

export function slugFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`Cannot make a box name from '${name}'.`);
  if (slug.length <= 24) return slug;
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 4);
  return `${slug.slice(0, 19).replace(/-+$/, "")}-${hash}`;
}

export const timedOut = 124;
export const coderLimitMs = 10 * 60_000;
const timeoutResult = (timeoutMs: number, stdout = ""): Result => ({ code: timedOut, stdout, stderr: `timed out after ${timeoutMs} ms` });

function kill(target: number): void {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    return;
  }
}

const realTimer: Timer = (ms, fire) => {
  const timeout = setTimeout(fire, Math.max(1, Math.ceil(ms)));
  return () => clearTimeout(timeout);
};

export function captureWith(timer: Timer): Capture {
  return async (argv, { env, stdin, timeoutMs, inherit = false }) => {
    const output = inherit ? "inherit" : "pipe";
    const child = Bun.spawn(argv, { env: env as Record<string, string> | undefined, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: output, stderr: output, detached: true });
    let expired = false;
    const cancel = timer(timeoutMs, () => {
      expired = true;
      kill(-child.pid);
      kill(child.pid);
    });
    try {
      const text = (stream: ReadableStream<Uint8Array> | number | undefined) => (stream instanceof ReadableStream ? new Response(stream).text() : "");
      const [stdout, stderr, code] = await Promise.all([text(child.stdout), text(child.stderr), child.exited]);
      return expired ? timeoutResult(timeoutMs, stdout) : { code, stdout, stderr };
    } finally {
      cancel();
    }
  };
}

export const capture = captureWith(realTimer);
const limit = (timeoutMs: number) => AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));

export class Coder {
  readonly env: Env;
  private readonly home: string;
  private readonly template: string;
  private readonly capture: Capture;
  private readonly fetch: typeof fetch;
  private found?: string;

  constructor(options: CoderOptions) {
    this.home = options.home;
    this.template = options.template;
    this.capture = options.capture ?? capture;
    this.fetch = options.fetch ?? fetch;
    this.env = { ...options.env };
    const fleet = join(options.home, ".config/fleet");
    const cli = join(options.home, ".config/coderv2");
    for (const [token, url] of [[join(fleet, "coder-session"), join(fleet, "coder-url")], [join(cli, "session"), join(cli, "url")]] as const) {
      if (this.env.CODER_SESSION_TOKEN || !existsSync(token)) continue;
      this.env.CODER_SESSION_TOKEN = readFileSync(token, "utf8").trim();
      if (existsSync(url)) this.env.CODER_URL = readFileSync(url, "utf8").trim();
    }
    this.env.CODER_URL ||= options.coderUrl;
  }

  async binary(): Promise<string> {
    const found = await this.resolve(coderLimitMs);
    if (!found) throw new Error("Cannot download the coder CLI: it timed out");
    return found;
  }

  private async resolve(timeoutMs: number): Promise<string | undefined> {
    this.found ??= Bun.which("coder", { PATH: this.env.PATH ?? "" }) ?? (await this.download(timeoutMs));
    return this.found;
  }

  private async download(timeoutMs: number): Promise<string | undefined> {
    const target = join(this.home, ".local/bin/coder");
    if (existsSync(target)) return target;
    if (!this.env.CODER_URL) throw new Error("No coder CLI and no Coder address. Set hub.coderUrl with fleet set.");
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    mkdirSync(dirname(target), { recursive: true });
    const partial = join(dirname(target), `.coder.${crypto.randomUUID()}`);
    closeSync(openSync(partial, "wx", 0o600));
    const fetched = await this.capture(["curl", "-fsSL", "-o", partial, `${this.env.CODER_URL}/bin/coder-linux-${arch}`], { env: this.env, timeoutMs });
    if (fetched.code !== 0) {
      rmSync(partial, { force: true });
      if (fetched.code === timedOut) return undefined;
      throw new Error(`Cannot download the coder CLI: ${fetched.stderr.trim()}`);
    }
    chmodSync(partial, 0o755);
    renameSync(partial, target);
    return target;
  }

  private async call(args: string[], stdin?: string, timeoutMs = coderLimitMs): Promise<Result> {
    const began = Date.now();
    const binary = await this.resolve(timeoutMs);
    const left = timeoutMs - (Date.now() - began);
    if (!binary || left <= 0) return timeoutResult(timeoutMs);
    return this.capture([binary, ...args], { env: this.env, ...(stdin === undefined ? {} : { stdin }), timeoutMs: left });
  }

  private async must(args: string[], timeoutMs?: number): Promise<string> {
    const result = await this.call(args, undefined, timeoutMs);
    if (result.code !== 0) throw new Error(`coder ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  }

  async boxes(timeoutMs?: number): Promise<Box[]> {
    const workspaces = JSON.parse(await this.must(["list", "-o", "json"], timeoutMs)) as Array<{ id: string; name: string; template_name: string; last_used_at: string; latest_build: { status: string } }>;
    return workspaces
      .filter((workspace) => workspace.name.startsWith(boxPrefix))
      .map((workspace) => ({ name: workspace.name, id: workspace.id, template: workspace.template_name, status: workspace.latest_build.status, lastUsedAt: workspace.last_used_at }));
  }

  async create(name: string, from: string, diskGigabytes: number, timeoutMs = coderLimitMs): Promise<string> {
    const signal = limit(timeoutMs);
    const { id, parameters: known } = await this.activeTemplate(signal);
    const copied = await this.api<Array<{ name: string; value: string }>>(`/api/v2/workspacebuilds/${(await this.workspace(from, signal)).latest_build.id}/parameters`, undefined, signal);
    const parameters = new Map(copied.filter((parameter) => known.includes(parameter.name)).map((parameter) => [parameter.name, parameter.value]));
    const overrides: Record<string, string | undefined> = { disk_size: String(diskGigabytes), auto_start_app: "false", clone_source_instance_id: "", dotfiles_branch: this.env.FLEET_BOX_DOTFILES_BRANCH };
    for (const [key, value] of Object.entries(overrides)) if (value !== undefined && known.includes(key)) parameters.set(key, value);
    const rich_parameter_values = [...parameters].map(([key, value]) => ({ name: key, value }));
    const created = await this.api<{ id: string }>("/api/v2/users/me/workspaces", { method: "POST", body: { name, template_id: id, rich_parameter_values, ttl_ms: idleStopMs } }, signal);
    return created.id;
  }

  private async activeTemplate(signal?: AbortSignal): Promise<{ id: string; versionId: string; parameters: string[] }> {
    const templates = await this.api<Array<{ id: string; name: string; active_version_id: string }>>("/api/v2/templates", undefined, signal);
    const found = templates.find((candidate) => candidate.name === this.template);
    if (!found) throw new Error(`Coder has no ${this.template} template. Set hub.boxTemplate with fleet set.`);
    const parameters = await this.api<Array<{ name: string }>>(`/api/v2/templateversions/${found.active_version_id}/rich-parameters`, undefined, signal);
    return { id: found.id, versionId: found.active_version_id, parameters: parameters.map((parameter) => parameter.name) };
  }

  private workspace(name: string, signal?: AbortSignal): Promise<{ id: string; latest_build: { id: string } }> {
    return this.api(`/api/v2/users/me/workspace/${name}`, undefined, signal);
  }

  private async api<T>(path: string, change?: { method: "POST" | "PUT"; body?: unknown }, signal?: AbortSignal): Promise<T> {
    const response = await this.fetch(`${this.env.CODER_URL}${path}`, {
      ...(change ? { method: change.method, body: JSON.stringify(change.body) } : {}),
      ...(signal ? { signal } : {}),
      headers: { "Coder-Session-Token": this.env.CODER_SESSION_TOKEN ?? "", "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error(`Coder API ${path} returned ${response.status}: ${(await response.text()).trim()}`);
    return response.json() as Promise<T>;
  }

  async start(id: string, timeoutMs: number, { update = false } = {}): Promise<void> {
    const signal = limit(timeoutMs);
    const path = `/api/v2/workspaces/${id}/builds`;
    if (update) {
      try {
        const { versionId } = await this.activeTemplate(signal);
        await this.api(path, { method: "POST", body: { transition: "start", template_version_id: versionId } }, signal);
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        console.error(`Fleet box: workspace ${id} keeps its template version: ${(error as Error).message}`);
      }
    }
    await this.api(path, { method: "POST", body: { transition: "start" } }, signal);
  }

  async stop(id: string, timeoutMs = coderLimitMs): Promise<void> {
    await this.api(`/api/v2/workspaces/${id}/builds`, { method: "POST", body: { transition: "stop" } }, limit(timeoutMs));
  }

  async remove(id: string, timeoutMs = coderLimitMs): Promise<void> {
    await this.api(`/api/v2/workspaces/${id}/builds`, { method: "POST", body: { transition: "delete" } }, limit(timeoutMs));
  }

  async extend(id: string, deadline: string, timeoutMs = coderLimitMs): Promise<void> {
    await this.api(`/api/v2/workspaces/${id}/extend`, { method: "PUT", body: { deadline } }, limit(timeoutMs));
  }

  private sshArgs(wait: "yes" | "no", name: string, command: string): string[] {
    return ["ssh", "--disable-autostart", `--wait=${wait}`, name, "--", command];
  }

  sshAfterStartup(name: string, command: string, timeoutMs?: number): Promise<Result> {
    return this.call(this.sshArgs("yes", name, command), undefined, timeoutMs);
  }

  async run(name: string, command: string): Promise<number> {
    return Bun.spawnSync([await this.binary(), ...this.sshArgs("no", name, command)], { env: this.env as Record<string, string>, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;
  }

  ssh(name: string, command: string, stdin?: string, timeoutMs?: number): Promise<Result> {
    return this.call(this.sshArgs("no", name, command), stdin, timeoutMs);
  }

  token(args: string[]): Promise<string> {
    return this.must(["tokens", ...args]);
  }
}

export type ReapOptions = { days: number; dryRun: boolean; now: number; print(line: string): void };

export async function reap(coder: { boxes(): Promise<Box[]> }, options: ReapOptions, remove: (box: string, stillStale: () => Promise<boolean>) => Promise<number>): Promise<number> {
  const cutoff = options.now - options.days * 86_400_000;
  const stale = (box: Box | undefined) => !!box && idleStatuses.has(box.status) && Date.parse(box.lastUsedAt) < cutoff;
  const current = async (name: string) => (await coder.boxes()).find((candidate) => candidate.name === name);
  let failed = 0;
  for (const listed of await coder.boxes()) {
    const box = stale(listed) && !options.dryRun ? await current(listed.name) : listed;
    const doomed = stale(box);
    options.print(`${doomed ? (options.dryRun ? "would delete" : "delete") : "keep"}: ${listed.name} (${box?.status ?? "gone"}, last used ${box?.lastUsedAt ?? listed.lastUsedAt})`);
    if (!doomed || options.dryRun) continue;
    try {
      if ((await remove(listed.name, async () => stale(await current(listed.name)))) !== 0) failed = 1;
    } catch (error) {
      failed = 1;
      options.print(`${listed.name}: ${(error as Error).message}`);
    }
  }
  return failed;
}

type Token = { id: string; token_name: string; expires_at: string };
export type GrantOptions = { ifExpiring: boolean; now: number; onDevbox(target: string, command: string, stdin?: string): Promise<Result>; print(line: string): void };

export async function grant(coder: { env: Env; token(args: string[]): Promise<string> }, target: string, options: GrantOptions): Promise<number> {
  const prefix = `fleet-${target}-`;
  const ours = (token: string) => token.startsWith(prefix) && /^\d{12}-[0-9a-f]{4}$/.test(token.slice(prefix.length));
  const tokens = (JSON.parse(await coder.token(["list", "-o", "json"])) as Token[]).filter((token) => ours(token.token_name));
  if (options.ifExpiring) {
    const keyId = (await options.onDevbox(target, "cut -d- -f1 ~/.config/fleet/coder-session 2>/dev/null")).stdout.trim();
    const installed = tokens.find((token) => token.id === keyId);
    if (installed && Date.parse(installed.expires_at) - options.now > tokenRenewWithinMs) {
      options.print(`${installed.token_name}: still valid until ${installed.expires_at}`);
      return 0;
    }
  }
  const name = `${prefix}${new Date(options.now).toISOString().replace(/\D/g, "").slice(0, 12)}-${crypto.randomUUID().slice(0, 4)}`;
  const token = (await coder.token(["create", "--name", name, "--lifetime", tokenLifetime, ...tokenScopes.flatMap((scope) => ["--scope", scope])])).trim();
  const write = async (file: string, content: string) => {
    const install = `umask 077 && mkdir -p ~/.config/fleet && t=$(mktemp ~/.config/fleet/.${file}.XXXXXX) && cat > "$t" && chmod 600 "$t" && mv -f "$t" ~/.config/fleet/${file}`;
    const pushed = await options.onDevbox(target, install, `${content}\n`);
    if (pushed.code !== 0) throw new Error(`Cannot write ${file} on ${target}: ${pushed.stderr.trim()}`);
  };
  try {
    await write("coder-url", coder.env.CODER_URL ?? "");
    await write("coder-session", token);
  } catch (error) {
    await coder.token(["remove", name]);
    throw error;
  }
  for (const old of tokens) await coder.token(["remove", old.token_name]);
  options.print(`${name}: granted for ${tokenLifetime}.`);
  return 0;
}
