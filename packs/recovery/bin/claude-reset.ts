import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { accessSync, constants as fileModes, readFileSync, realpathSync, statSync } from "node:fs";
import { constants, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

type RateLimitInfo = { status?: string; resetsAt?: number; rateLimitType?: string; overageStatus?: string; isUsingOverage?: boolean };
type Frame = { type?: string; subtype?: string; model?: string; parent_tool_use_id?: string | null; error?: string; session_id?: string; rate_limit_info?: RateLimitInfo; is_error?: boolean; api_error_status?: number };
type Proxy = { baseUrl: string; key: string };

const maxResetMs = 30 * 24 * 3600_000;
const proxyTimeoutMs = 5000;
const fleetKeyHelper = 'cat "$HOME/.config/fleet/cli-proxy.key"';

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, "utf8").trim() || undefined; }
  catch { return undefined; }
}

function proxyConfiguration(home: string): Proxy | undefined {
  const settings = readJson(join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json"));
  const settingsEnv = (typeof settings.env === "object" && settings.env !== null ? settings.env : {}) as Record<string, unknown>;
  const value = (name: string) => {
    const found = process.env[name] || settingsEnv[name];
    return typeof found === "string" && found ? found : undefined;
  };
  const baseUrl = value("ANTHROPIC_BASE_URL");
  const fleetKey = settings.apiKeyHelper === fleetKeyHelper ? readText(join(home, ".config/fleet/cli-proxy.key")) : undefined;
  const key = value("ANTHROPIC_AUTH_TOKEN") || value("ANTHROPIC_API_KEY") || fleetKey;
  if (!baseUrl || !key) return undefined;
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.hostname === "api.anthropic.com" || url.username || url.password) return undefined;
  } catch {
    return undefined;
  }
  return { baseUrl, key };
}

function resetTime(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= now || milliseconds - now > maxResetMs) return undefined;
  return milliseconds / 1000;
}

async function proxyReset(proxy: Proxy, model: string, signal: AbortSignal): Promise<number | undefined> {
  try {
    const response = await fetch(`${proxy.baseUrl.replace(/\/$/, "")}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "x-api-key": proxy.key, Authorization: `Bearer ${proxy.key}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: model.replace(/\[1m\]$/i, ""), messages: [{ role: "user", content: "quota" }] }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(proxyTimeoutMs)]),
      redirect: "error",
    });
    await response.body?.cancel();
    return response.status === 429 ? resetTime(response.headers.get("Retry-After"), Date.now()) : undefined;
  } catch {
    return undefined;
  }
}

function parseFrame(line: string): Frame | undefined {
  try {
    const frame: unknown = JSON.parse(line);
    return typeof frame === "object" && frame !== null ? frame as Frame : undefined;
  } catch {
    return undefined;
  }
}

async function writeLine(line: string): Promise<void> {
  if (!process.stdout.write(`${line}\n`)) await once(process.stdout, "drain");
}

function claudeExecutable(home: string, cwd: string): string {
  if (process.env.FLEET_CLAUDE_EXECUTABLE) return process.env.FLEET_CLAUDE_EXECUTABLE;
  const wrapper = realpathSync(join(import.meta.dir, "claude"));
  for (const folder of (process.env.PATH ?? "").split(":")) {
    const candidate = resolve(cwd, folder || ".", "claude");
    try {
      accessSync(candidate, fileModes.X_OK);
      if (statSync(candidate).isFile() && realpathSync(candidate) !== wrapper) return candidate;
    } catch {}
  }
  return join(home, ".local/bin/claude");
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function trackNativeReset(resets: Map<string, number | undefined>, info: RateLimitInfo) {
  const type = info.rateLimitType || "unknown";
  const overage = info.isUsingOverage || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
  if (info.status === "rejected" && !overage) {
    const reset = info.resetsAt;
    resets.set(type, typeof reset === "number" && Number.isFinite(reset) && reset * 1000 > Date.now() && reset * 1000 < 8.64e15 ? reset : undefined);
  } else if (info.status === "allowed" || info.status === "allowed_warning" || overage) resets.delete(type);
}

async function relay(stdout: NodeJS.ReadableStream, proxy: Proxy, args: string[], aborted: AbortSignal) {
  let model = optionValue(args, "--model");
  let limited = false;
  const nativeResets = new Map<string, number | undefined>();
  for await (const line of createInterface({ input: stdout, crlfDelay: Infinity })) {
    const frame = parseFrame(line);
    if (frame?.type === "system" && frame.subtype === "init" && frame.model) model = frame.model;
    if (frame?.type === "assistant" && frame.parent_tool_use_id == null) limited = frame.error === "rate_limit";
    if (frame?.type === "rate_limit_event" && frame.rate_limit_info) trackNativeReset(nativeResets, frame.rate_limit_info);
    if (frame?.type === "result") {
      const missing = nativeResets.size ? [...nativeResets].filter(([, reset]) => reset === undefined).map(([type]) => type) : ["unknown"];
      const failedOnLimit = frame.is_error === true && frame.session_id && (frame.api_error_status == null || frame.api_error_status === 429);
      if ((limited || nativeResets.size > 0) && missing.length && model && failedOnLimit) {
        const resetsAt = await proxyReset(proxy, model, aborted);
        if (resetsAt !== undefined) {
          for (const type of missing) {
            await writeLine(JSON.stringify({
              type: "rate_limit_event",
              rate_limit_info: { status: "rejected", resetsAt, ...(type === "unknown" ? {} : { rateLimitType: type }) },
              uuid: randomUUID(),
              session_id: frame.session_id,
            }));
          }
        }
      }
      limited = false;
      nativeResets.clear();
    }
    await writeLine(line);
  }
}

async function main(args: string[]): Promise<number> {
  const home = process.env.HOME || homedir();
  const streamJson = optionValue(args, "--output-format") === "stream-json";
  const proxy = streamJson ? proxyConfiguration(home) : undefined;
  const { FLEET_CLAUDE_CWD: launchedIn, ...env } = process.env;
  const cwd = launchedIn || process.cwd();
  const child = spawn(claudeExecutable(home, cwd), args, { cwd, env, stdio: ["inherit", proxy ? "pipe" : "inherit", "inherit"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const aborted = new AbortController();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map((signal) => {
    const handler = () => { aborted.abort(); child.kill(signal); };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  try {
    if (proxy && child.stdout) await relay(child.stdout, proxy, args, aborted.signal);
    const { code, signal } = await exited;
    return code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
  } catch (error) {
    aborted.abort();
    child.kill("SIGTERM");
    console.error(`Fleet's Claude wrapper: ${(error as Error).message}`);
    return 1;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

process.exit(await main(process.argv.slice(2)));
