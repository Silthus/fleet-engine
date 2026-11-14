import { expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadWord } from "../../pull-requests/lib/proof-answers.ts";
import type { Ssh, SshResult } from "./hub-transport.ts";
import { secretCommand, type SecretContext } from "./secret-cli.ts";
import { appendToLog, eventLogPath, secretFilesDir, valuesDir, type CheckResult, type SecretRow, type WriteBytes } from "./secret-store.ts";

export const homes: string[] = [];
export const removeHomes = () => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }));

export const made = (prefix: string) => `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
export const sendKey = made("key_");
export const otherKey = made("key_");
export const euKey = made("key_");
export const foreignKey = made("key_");
export const loginEmail = `sandbox-${crypto.randomUUID().slice(0, 8)}@example.com`;
export const loginPassword = `pw-${crypto.randomUUID()}`;
export const values = [sendKey, otherKey, euKey, foreignKey, loginEmail, loginPassword];

export const projectKey = (project: string): SecretRow["provider"] => ({
  name: "example-project-key",
  check: async ({ EXAMPLE_API_KEY: key = "" }): Promise<CheckResult> => {
    if (key.startsWith("personal_")) return { ok: false, reason: "this is a personal key, not a project key" };
    if (key === foreignKey) return { ok: false, reason: `the key belongs to another project than ${project}` };
    return { ok: true, unchecked: "the example service proves only that the key may read" };
  },
});

export const testRows = (): SecretRow[] => [
  { name: "send-us", provider: projectKey("12"), scope: "email:write", project: "12", region: "us", settings: "https://example.com/settings", env: ["EXAMPLE_API_KEY"] },
  { name: "send-eu", provider: projectKey("34"), scope: "email:write", project: "34", region: "eu", settings: "https://example.com/settings", env: ["EXAMPLE_API_KEY"] },
  { name: "sandbox-login", provider: { name: "example-login" }, scope: "the sandbox project only", project: "Sandbox", settings: "https://example.com/users", env: ["LOGIN_EMAIL", "LOGIN_PASSWORD"] },
  { name: "chat-app", provider: { name: "chat-app" }, scope: "the chat app's tokens", settings: "https://example.com/apps", env: ["CHAT_APP_TOKEN", "CHAT_BOT_TOKEN"], file: { path: ".config/fleet/chat-app.json", format: "json", fields: { appToken: "CHAT_APP_TOKEN", botToken: "CHAT_BOT_TOKEN" }, renew: "the steps in the chat pack's setup" } },
  { name: "speech", provider: { name: "speech" }, scope: "text to speech", settings: "https://example.com/keys", env: ["SPEECH_API_KEY"], file: { path: ".config/fleet/speech.env", format: "env", renew: "a 0600 ~/.config/fleet/speech.env with SPEECH_API_KEY=…" } },
  { name: "pager", provider: { name: "pager" }, scope: "one alert source", settings: "https://example.com/alerts", env: ["PAGER_URL", "PAGER_TOKEN"], file: { path: ".config/fleet/pager.env", format: "env", renew: "fleet page setup" } },
];

export const newHome = () => { const home = mkdtempSync(join(tmpdir(), "fleet-secret-")); homes.push(home); return home; };

export function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

export const hubSettings = JSON.stringify({ "hub.alias": "hub" });
export const text = (shown: string | Uint8Array) => typeof shown === "string" ? shown : Buffer.from(shown).toString("utf8");

export function fleet({ words = [] as ThreadWord[], rows = testRows() as SecretRow[] | "injected", handlers = undefined as Record<string, string> | undefined } = {}) {
  const hubHome = newHome();
  const devHome = newHome();
  mkdirSync(join(hubHome, ".config/fleet"), { recursive: true });
  writeFileSync(join(hubHome, ".config/fleet/machine.json"), JSON.stringify({ role: "hub" }));
  const clock = { now: new Date("2026-11-13T10:00:00Z") };
  const printed: string[] = [];
  const commands: string[] = [];
  const reach: { hub: boolean; answer?: SshResult } = { hub: true };
  const hooks: { whileHearing?: () => Promise<unknown>; beforeAppend?: () => void; write?: WriteBytes } = {};
  const write: WriteBytes = (file, bytes, offset) => (hooks.write ?? ((at, all, from) => writeSync(at, all, from)))(file, bytes, offset);
  const threadWords = async () => { const step = hooks.whileHearing; hooks.whileHearing = undefined; await step?.(); return words; };
  const env = (machine: string) => ({ FLEET_SETTINGS: hubSettings, CODER_WORKSPACE_NAME: machine, T3CODE_THREAD_ID: "lane-thread", ...handlers ? { FLEET_HANDLERS: JSON.stringify(handlers) } : {} });
  const context = (home: string, machine: string): SecretContext => ({
    home, env: env(machine), now: () => clock.now, threadWords, out: (shown) => printed.push(text(shown)), err: (shown) => printed.push(text(shown)), ssh,
    write, appendLog: (path, line, writer) => { const step = hooks.beforeAppend; hooks.beforeAppend = undefined; step?.(); appendToLog(path, line, writer); }, ...rows === "injected" ? {} : { rows },
  });
  const ssh: Ssh = async (host, command, stdin) => {
    commands.push(command);
    if (host !== "hub" || !reach.hub) return { code: 255, stdout: "", stderr: "ssh: connect to host hub port 22: Connection timed out" };
    if (reach.answer) return reach.answer;
    const out: string[] = [];
    const err: string[] = [];
    const code = await secretCommand(["hub"], { ...context(hubHome, "hub"), stdin: async () => stdin ?? "", out: (shown) => out.push(text(shown)), err: (shown) => err.push(text(shown)) });
    return { code, stdout: out.join(""), stderr: err.join("") };
  };
  const secretFile = (home: string, text: string) => {
    const dir = secretFilesDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, crypto.randomUUID());
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };
  const on = (home: string, machine: string) => (...args: string[]) => secretCommand(args, context(home, machine));
  const putElsewhere = ({ name, lane, env, value }: { name: string; lane: string; env: string; value: string }) => {
    const id = `p-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    mkdirSync(valuesDir(hubHome), { recursive: true, mode: 0o700 });
    writeFileSync(join(valuesDir(hubHome), `${name}.${id}`), `${env}=${value}\n`, { mode: 0o600 });
    const storeExpiresAt = new Date(clock.now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    appendFileSync(eventLogPath(hubHome), `\n${JSON.stringify({ type: "put", id, name, at: clock.now.toISOString(), why: "intake", storeExpiresAt, machine: "other-process", lane, env })}\n`);
  };
  const offElsewhere = (reason: string) => () => appendFileSync(eventLogPath(hubHome), `\n${JSON.stringify({ type: "off", id: `o-${reason.replaceAll(" ", "-")}`, reason, at: clock.now.toISOString(), machine: "other-process" })}\n`);
  return {
    hubHome, devHome, clock, printed, commands, reach, hooks, secretFile, offElsewhere, putElsewhere, ssh, devEnv: env("devbox-1"),
    hub: on(hubHome, "hub"), dev: on(devHome, "devbox-1"),
    since(before: number) { return printed.slice(before).join(""); },
    expectNoLeak(extra: string[] = []) {
      const shown = [...printed, ...commands, existsSync(eventLogPath(hubHome)) ? readFileSync(eventLogPath(hubHome), "utf8") : "", ...filesUnder(devHome).map((path) => readFileSync(path, "utf8"))].join("\n");
      for (const value of [...values, ...extra]) expect(shown).not.toContain(value);
    },
  };
}

export async function run(machine: (...args: string[]) => Promise<number>, printed: string[], names: string[], script: string) {
  const before = printed.length;
  const code = await machine("run", ...names, "--", "sh", "-c", script);
  return { code, text: printed.slice(before).join("") };
}

export const login = (email = loginEmail, password = loginPassword) => `LOGIN_EMAIL=${email}\nLOGIN_PASSWORD=${password}\n`;
