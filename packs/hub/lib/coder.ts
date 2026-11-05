import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
export type Box = { name: string; status: string; lastUsedAt: string };
export type Capture = (argv: string[], options?: { env?: Env; stdin?: string }) => Result;
export type CoderOptions = { home: string; env: Env; coderUrl: string; template: string; capture?: Capture; fetch?: typeof fetch };

export function slugFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`Cannot make a box name from '${name}'.`);
  if (slug.length <= 24) return slug;
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 4);
  return `${slug.slice(0, 19).replace(/-+$/, "")}-${hash}`;
}

export const capture: Capture = (argv, options = {}) => {
  const child = Bun.spawnSync(argv, { env: options.env as Record<string, string> | undefined, stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin), stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode ?? 1, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
};

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

  get binary(): string {
    this.found ??= Bun.which("coder", { PATH: this.env.PATH ?? "" }) ?? this.download();
    return this.found;
  }

  private download(): string {
    const target = join(this.home, ".local/bin/coder");
    if (existsSync(target)) return target;
    if (!this.env.CODER_URL) throw new Error("No coder CLI and no Coder address. Set hub.coderUrl with fleet set.");
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    mkdirSync(dirname(target), { recursive: true });
    const fetched = this.capture(["curl", "-fsSL", "-o", target, `${this.env.CODER_URL}/bin/coder-linux-${arch}`]);
    if (fetched.code !== 0) throw new Error(`Cannot download the coder CLI: ${fetched.stderr.trim()}`);
    if (existsSync(target)) chmodSync(target, 0o755);
    return target;
  }

  private call(args: string[], stdin?: string): Result {
    return this.capture([this.binary, ...args], { env: this.env, ...(stdin === undefined ? {} : { stdin }) });
  }

  private must(args: string[]): string {
    const result = this.call(args);
    if (result.code !== 0) throw new Error(`coder ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  }

  boxes(): Box[] {
    const workspaces = JSON.parse(this.must(["list", "-o", "json"])) as Array<{ name: string; last_used_at: string; latest_build: { status: string } }>;
    return workspaces.filter((workspace) => workspace.name.startsWith(boxPrefix)).map((workspace) => ({ name: workspace.name, status: workspace.latest_build.status, lastUsedAt: workspace.last_used_at }));
  }

  async create(name: string, from: string, diskGigabytes: number): Promise<void> {
    const { id, parameters: known } = await this.activeTemplate();
    const copied = await this.api<Array<{ name: string; value: string }>>(`/api/v2/workspacebuilds/${(await this.workspace(from)).latest_build.id}/parameters`);
    const parameters = new Map(copied.filter((parameter) => known.includes(parameter.name)).map((parameter) => [parameter.name, parameter.value]));
    const overrides: Record<string, string | undefined> = { disk_size: String(diskGigabytes), auto_start_app: "false", clone_source_instance_id: "", dotfiles_branch: this.env.FLEET_BOX_DOTFILES_BRANCH };
    for (const [key, value] of Object.entries(overrides)) if (value !== undefined && known.includes(key)) parameters.set(key, value);
    const rich_parameter_values = [...parameters].map(([key, value]) => ({ name: key, value }));
    await this.api("/api/v2/users/me/workspaces", { method: "POST", body: { name, template_id: id, rich_parameter_values, ttl_ms: idleStopMs } });
  }

  private async activeTemplate(): Promise<{ id: string; versionId: string; parameters: string[] }> {
    const templates = await this.api<Array<{ id: string; name: string; active_version_id: string }>>("/api/v2/templates");
    const found = templates.find((candidate) => candidate.name === this.template);
    if (!found) throw new Error(`Coder has no ${this.template} template. Set hub.boxTemplate with fleet set.`);
    const parameters = await this.api<Array<{ name: string }>>(`/api/v2/templateversions/${found.active_version_id}/rich-parameters`);
    return { id: found.id, versionId: found.active_version_id, parameters: parameters.map((parameter) => parameter.name) };
  }

  private workspace(name: string): Promise<{ id: string; latest_build: { id: string } }> {
    return this.api(`/api/v2/users/me/workspace/${name}`);
  }

  private async api<T>(path: string, change?: { method: "POST"; body?: unknown }): Promise<T> {
    const response = await this.fetch(`${this.env.CODER_URL}${path}`, {
      ...(change ? { method: change.method, body: JSON.stringify(change.body) } : {}),
      headers: { "Coder-Session-Token": this.env.CODER_SESSION_TOKEN ?? "", "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error(`Coder API ${path} returned ${response.status}: ${(await response.text()).trim()}`);
    return response.json() as Promise<T>;
  }

  async start(name: string, { update = false } = {}): Promise<void> {
    const path = `/api/v2/workspaces/${(await this.workspace(name)).id}/builds`;
    if (update) {
      try {
        const { versionId } = await this.activeTemplate();
        await this.api(path, { method: "POST", body: { transition: "start", template_version_id: versionId } });
        return;
      } catch (error) {
        console.error(`Fleet box: ${name} keeps its template version: ${(error as Error).message}`);
      }
    }
    await this.api(path, { method: "POST", body: { transition: "start" } });
  }

  stop(name: string): void {
    this.must(["stop", "-y", name]);
  }

  extend(name: string, duration: string): void {
    this.must(["schedule", "extend", name, duration]);
  }

  remove(name: string): void {
    this.must(["delete", "-y", name]);
  }

  private sshTo(wait: "yes" | "no", name: string, command: string): string[] {
    return [this.binary, "ssh", "--disable-autostart", `--wait=${wait}`, name, "--", command];
  }

  sshAfterStartup(name: string, command: string): Result {
    return this.capture(this.sshTo("yes", name, command), { env: this.env });
  }

  run(name: string, command: string): number {
    return Bun.spawnSync(this.sshTo("no", name, command), { env: this.env as Record<string, string>, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;
  }

  async sshLater(name: string, command: string): Promise<Result> {
    const child = Bun.spawn(this.sshTo("no", name, command), { env: this.env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, stdout, stderr };
  }

  ssh(name: string, command: string, stdin?: string): Result {
    return this.capture(this.sshTo("no", name, command), { env: this.env, ...(stdin === undefined ? {} : { stdin }) });
  }

  token(args: string[]): string {
    return this.must(["tokens", ...args]);
  }
}

export type ReapOptions = { days: number; dryRun: boolean; now: number; print(line: string): void };

export async function reap(coder: { boxes(): Box[] }, options: ReapOptions, remove: (box: string, stillStale: () => boolean) => Promise<unknown>): Promise<number> {
  const cutoff = options.now - options.days * 86_400_000;
  const stale = (box: Box | undefined) => !!box && idleStatuses.has(box.status) && Date.parse(box.lastUsedAt) < cutoff;
  const current = (name: string) => coder.boxes().find((candidate) => candidate.name === name);
  for (const listed of coder.boxes()) {
    const box = stale(listed) && !options.dryRun ? current(listed.name) : listed;
    const doomed = stale(box);
    options.print(`${doomed ? (options.dryRun ? "would delete" : "delete") : "keep"}: ${listed.name} (${box?.status ?? "gone"}, last used ${box?.lastUsedAt ?? listed.lastUsedAt})`);
    if (doomed && !options.dryRun) await remove(listed.name, () => stale(current(listed.name)));
  }
  return 0;
}

type Token = { id: string; token_name: string; expires_at: string };
export type GrantOptions = { ifExpiring: boolean; now: number; onDevbox(target: string, command: string, stdin?: string): Result; print(line: string): void };

export function grant(coder: { env: Env; token(args: string[]): string }, target: string, options: GrantOptions): number {
  const prefix = `fleet-${target}-`;
  const ours = (token: string) => token.startsWith(prefix) && /^\d{12}-[0-9a-f]{4}$/.test(token.slice(prefix.length));
  const tokens = (JSON.parse(coder.token(["list", "-o", "json"])) as Token[]).filter((token) => ours(token.token_name));
  if (options.ifExpiring) {
    const keyId = options.onDevbox(target, "cut -d- -f1 ~/.config/fleet/coder-session 2>/dev/null").stdout.trim();
    const installed = tokens.find((token) => token.id === keyId);
    if (installed && Date.parse(installed.expires_at) - options.now > tokenRenewWithinMs) {
      options.print(`${installed.token_name}: still valid until ${installed.expires_at}`);
      return 0;
    }
  }
  const name = `${prefix}${new Date(options.now).toISOString().replace(/\D/g, "").slice(0, 12)}-${crypto.randomUUID().slice(0, 4)}`;
  const token = coder.token(["create", "--name", name, "--lifetime", tokenLifetime, ...tokenScopes.flatMap((scope) => ["--scope", scope])]).trim();
  const write = (file: string, content: string) => {
    const install = `umask 077 && mkdir -p ~/.config/fleet && t=$(mktemp ~/.config/fleet/.${file}.XXXXXX) && cat > "$t" && chmod 600 "$t" && mv -f "$t" ~/.config/fleet/${file}`;
    const pushed = options.onDevbox(target, install, `${content}\n`);
    if (pushed.code !== 0) throw new Error(`Cannot write ${file} on ${target}: ${pushed.stderr.trim()}`);
  };
  try {
    write("coder-url", coder.env.CODER_URL ?? "");
    write("coder-session", token);
  } catch (error) {
    coder.token(["remove", name]);
    throw error;
  }
  for (const old of tokens) coder.token(["remove", old.token_name]);
  options.print(`${name}: granted for ${tokenLifetime}.`);
  return 0;
}
