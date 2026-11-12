import type { Context } from "../../../src/sdk/index.ts";

export const sourceSecret = "source";

export const usage = `Usage: fleet page --key <key> --title <title> [--description <text>] [--source-url <url>] [--priority <value>] [--dry-run]
       fleet page --key <key> --resolve [--title <title>] [--dry-run]
       fleet page setup <alert source URL> < <token file>

Sends one alert event to your incident.io HTTP alert source. The alert route on that
source decides who is paged, not this command. Set it up to page only you.

  --key <key>          Deduplication key. Required. The same key never pages twice, so a
                       retry is safe. Use the same key with --resolve to withdraw the page.
  --title <title>      What happened, in a few words. Required unless --resolve.
  --description <text> What to look at, and how to undo it.
  --source-url <url>   A link to the evidence, such as a dashboard.
  --priority <value>   Goes into the event's metadata. incident.io has no priority field.
  --resolve            Sends status "resolved" for --key. The route withdraws the page.
  --dry-run            Checks the input and the saved source, prints the event, sends nothing.

  setup <URL>          Saves the alert source URL and the token on standard input.

With a hub, the command runs on the hub, so the token lives only there.
It prints the HTTP status and incident.io's answer, never the token or the URL.
Exit 0: incident.io accepted the event. 1: it did not, or the source is not set up,
or the hub did not answer. 2: wrong input.`;

const setupLine = "fleet page setup <alert source URL> < <token file>";

type Source = { url: string; token: string };
type Flags = { key?: string; title?: string; description?: string; sourceUrl?: string; priority?: string; resolve: boolean; dryRun: boolean };
export type PageEvent = { title: string; status: "firing" | "resolved"; deduplication_key: string; description?: string; source_url?: string; metadata: Record<string, string> };

class InputError extends Error {}

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];

function urlProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "is not a URL";
  }
  const incident = parsed.protocol === "https:" && parsed.hostname === "api.incident.io" && !parsed.port;
  const loopback = parsed.protocol === "http:" && loopbackHosts.includes(parsed.hostname);
  if (!incident && !loopback) return "is not an https://api.incident.io URL";
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return "has more than a path";
  if (!/^\/v2\/alert_events\/http\/[A-Za-z0-9]+$/.test(parsed.pathname)) return "is not an /v2/alert_events/http/<alert source config id> URL";
  return undefined;
}

async function savedSource(ctx: Context): Promise<Source> {
  const saved = await ctx.secrets.read(sourceSecret);
  if (saved === undefined) throw new Error(`no incident.io alert source is saved here. Set it up: ${setupLine}`);
  let source: Partial<Source>;
  try {
    source = JSON.parse(saved);
  } catch {
    throw new Error(`the saved alert source is not readable. Save it again: ${setupLine}`);
  }
  if (typeof source.url !== "string" || typeof source.token !== "string" || !source.token) throw new Error(`the saved alert source has no URL or no token. Save it again: ${setupLine}`);
  const problem = urlProblem(source.url);
  if (problem) throw new Error(`the saved alert source URL ${problem}. Save it again: ${setupLine}`);
  return { url: source.url, token: source.token };
}

export async function sourceSaved(ctx: Context): Promise<boolean> {
  try {
    return await savedSource(ctx), true;
  } catch {
    return false;
  }
}

const valued = { "--key": "key", "--title": "title", "--description": "description", "--source-url": "sourceUrl", "--priority": "priority" } as const;

function parseFlags(args: string[]): Flags {
  const flags: Flags = { resolve: false, dryRun: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--resolve") flags.resolve = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (!Object.hasOwn(valued, name)) throw new InputError(`unknown argument ${arg}`);
      const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (value === undefined) throw new InputError(`${name} needs a value`);
      flags[valued[name as keyof typeof valued]] = value;
    }
  }
  return flags;
}

function eventOf(flags: Flags): PageEvent {
  const key = flags.key?.trim();
  if (!key) throw new InputError("--key is required, so a retry never pages twice");
  if (key.length > 200) throw new InputError("--key must be at most 200 characters");
  const title = flags.title?.trim() || (flags.resolve ? `Resolved: ${key}` : "");
  if (!title) throw new InputError("--title is required");
  if (flags.sourceUrl !== undefined && !/^https?:\/\/\S+$/.test(flags.sourceUrl)) throw new InputError("--source-url must be an http or https URL");
  const description = flags.description?.trim();
  const priority = flags.priority?.trim();
  return {
    title,
    status: flags.resolve ? "resolved" : "firing",
    deduplication_key: key,
    ...(description ? { description } : {}),
    ...(flags.sourceUrl ? { source_url: flags.sourceUrl } : {}),
    metadata: { sent_by: "fleet page", ...(priority ? { priority } : {}) },
  };
}

function redactor({ url, token }: Source) {
  const secrets = [token, url, url.split("/").at(-1)!].filter((secret) => secret.length >= 4).sort((a, b) => b.length - a.length);
  return (text: string) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text).slice(0, 500);
}

const retry = "Send it again with the same --key: it never pages twice.";

async function send(source: Source, event: PageEvent, ctx: Context): Promise<number> {
  const redact = redactor(source);
  let response: Response;
  try {
    response = await fetch(source.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${source.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    ctx.print(`fleet page: not sent: ${redact((error as Error).message)}. ${retry}`);
    return 1;
  }
  const answer = await response.text().catch(() => "");
  let body: { status?: unknown; message?: unknown; errors?: unknown } = {};
  try {
    body = JSON.parse(answer);
  } catch {}
  const errors = Array.isArray(body.errors) ? body.errors.map((each) => (each as { message?: unknown } | null)?.message) : [];
  const parts = [body.status, body.message, ...errors].filter((part) => typeof part === "string" || typeof part === "number").map((part) => redact(String(part)));
  const line = `HTTP ${response.status}${parts.length ? `: ${parts.join(": ")}` : ""}`;
  if (response.ok) {
    ctx.print(`fleet page: ${event.status === "resolved" ? "resolved" : "sent"} ${event.deduplication_key}. ${line}`);
    return 0;
  }
  ctx.print(`fleet page: incident.io did not accept the event. ${line}. ${retry}`);
  return 1;
}

async function setup(args: string[], ctx: Context): Promise<number> {
  const [url, ...rest] = args;
  if (!url || rest.length) throw new InputError(`setup takes the alert source URL alone: ${setupLine}`);
  const problem = urlProblem(url);
  if (problem) throw new InputError(`the alert source URL ${problem}`);
  const token = (await new Response(ctx.stdin()).text()).trim();
  if (!token || /\s/.test(token)) throw new InputError("standard input must hold the alert source token alone, on one line");
  await ctx.secrets.write(sourceSecret, `${JSON.stringify({ url, token })}\n`);
  ctx.print('fleet page: saved the alert source. Check it with: fleet page --key setup-check --title "Setup check" --dry-run');
  return 0;
}

export async function page(args: string[], ctx: Context): Promise<number> {
  try {
    if (!args.length || args.includes("--help") || args.includes("-h")) return ctx.print(usage), args.length ? 0 : 2;
    if (args[0] === "setup") return await setup(args.slice(1), ctx);
    const flags = parseFlags(args);
    const event = eventOf(flags);
    const source = await savedSource(ctx);
    if (!flags.dryRun) return await send(source, event, ctx);
    ctx.print("fleet page: dry run, nothing sent. It would POST this to the saved alert source:");
    ctx.print("Authorization: Bearer [redacted]");
    ctx.print(JSON.stringify(event, null, 2));
    return 0;
  } catch (error) {
    ctx.print(`fleet page: ${(error as Error).message}`);
    if (!(error instanceof InputError)) return 1;
    ctx.print("Run fleet page --help for the flags.");
    return 2;
  }
}
