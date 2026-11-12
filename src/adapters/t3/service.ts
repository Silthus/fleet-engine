import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkParents } from "../../files/install.ts";
import { writePrivateFile } from "../../files/private.ts";
import type { Finding } from "../../pack/types.ts";
import type { AdapterResult } from "../../reconciler/apply.ts";
import type { CommandRunner } from "../run.ts";

export type Wait = (ms: number) => Promise<void>;
export type Environment = Record<string, string | undefined>;

const bounded = ["--connect-timeout", "20", "--speed-limit", "1024", "--speed-time", "60"];
const releasesFeed = "https://github.com/pingdotgg/t3code/releases.atom";
const nightlyTag = /\/releases\/tag\/v([0-9][0-9.]*-nightly\.[0-9]+\.[0-9]+)"/;
const installScript = `installer=$(mktemp) && curl -fsSL ${bounded.join(" ")} https://t3.codes/install.sh -o "$installer" && T3CODE_CHANNEL=nightly sh "$installer"; code=$?; rm -f "$installer"; exit $code`;
const tries = 3;

const installT3 = (version: string) => ["env", `T3CODE_VERSION=${version}`, "/bin/sh", "-c", installScript];

async function retried(attempt: () => ReturnType<CommandRunner>, wait: Wait) {
  for (let tried = 1; ; tried++) {
    const result = await attempt();
    if (result.code === 0 || tried === tries) return result;
    await wait(tried * 1000);
  }
}

async function newestNightly(run: CommandRunner, wait: Wait) {
  const feed = await retried(() => run(["curl", "-fsSL", ...bounded, releasesFeed]), wait);
  return feed.code === 0 ? (feed.stdout.match(nightlyTag)?.[1] ?? "") : "";
}

const finding = (id: string, say: string, repair: Finding["repair"]): Finding => ({ id: `t3:${id}`, pack: "engine", say, repair });

const tokenFolder = ".config/claude-env";
const tokenFile = `${tokenFolder}/oauth.env`;
const pendingFile = `${tokenFolder}/restart-pending`;
const tokenDropIn = ".config/systemd/user/t3code.service.d/claude-token.conf";
const dropInText = `[Service]\nEnvironmentFile=%h/${tokenFile}\n`;
const tokenShape = /^[A-Za-z0-9._~+/=-]+$/;
const needsReload = "reload";
export const restartCommand = "systemctl --user restart t3code.service";

const tokenFinding = (say: string, repair: Finding["repair"] = "human") => finding("claude-token", say, repair);

const readOr = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Only a missing file reads as absent. Any other error throws, so a file Fleet cannot read is never taken for one it may write. */
const readIfThere = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const invocationId = /^[0-9a-f]{32}$/;

/** What the restart marker owes: nothing, a reload, or a restart of the T3 Code started under that invocation. A marker Fleet did not write owes a reload again, so a spoiled marker never drops the token. */
async function owedRestart(pending: string): Promise<string | undefined> {
  const marker = lstatSync(pending, { throwIfNoEntry: false });
  if (!marker) return undefined;
  const text = marker.isFile() ? readOr(pending) : undefined;
  if (text === needsReload || (text !== undefined && invocationId.test(text))) return text;
  rmSync(pending, { recursive: true, force: true });
  await writePrivateFile(pending, needsReload);
  return needsReload;
}

const privateMode = (path: string, mode: number) => (lstatSync(path, { throwIfNoEntry: false })?.mode ?? 0) % 0o1000 === mode;

async function realFolders(home: string) {
  try {
    for (const target of [tokenFile, tokenDropIn]) await checkParents(home, target);
    return true;
  } catch {
    return false;
  }
}

const insideT3 = (env: Environment) => Boolean(env.T3CODE_THREAD_ID || env.T3CODE_PORT);

async function invocation(run: CommandRunner) {
  const shown = await run(["systemctl", "--user", "show", "t3code.service", "--property=InvocationID", "--value"]);
  return shown.code === 0 ? shown.stdout.trim() : undefined;
}

async function loadToken(run: CommandRunner, env: Environment, pending: string, result: AdapterResult) {
  let loadedAt = await owedRestart(pending);
  if (loadedAt === needsReload) {
    if ((await run(["systemctl", "--user", "daemon-reload"])).code !== 0) return void result.findings.push(tokenFinding(`systemd did not reload T3 Code's service, so T3 Code runs without the Claude token. Run fleet apply again, or run: systemctl --user daemon-reload && ${restartCommand}`));
    loadedAt = await invocation(run);
    if (loadedAt !== undefined && invocationId.test(loadedAt)) await writePrivateFile(pending, loadedAt);
  } else if (loadedAt !== undefined) {
    const now = await invocation(run);
    if (now !== undefined && now !== loadedAt) return void rmSync(pending, { force: true });
  }
  if (insideT3(env)) return void result.findings.push(tokenFinding(`T3 Code picks up the Claude token at its next restart. Fleet did not restart it, because this apply runs inside T3 Code and the restart would end it. From a shell outside T3 Code, run: ${restartCommand}`));
  if ((await run(["systemctl", "--user", "try-restart", "t3code.service"])).code !== 0) return void result.findings.push(tokenFinding(`T3 Code did not restart with the new Claude token. Run fleet apply again, or run: ${restartCommand}`));
  rmSync(pending, { force: true });
}

/** T3 Code's user service does not inherit the session, so a Claude token that the session gets from its environment reaches T3 through a file. A drop-in that Fleet did not write stays. */
export async function reconcileClaudeToken(run: CommandRunner, home: string, env: Environment, dryRun: boolean, result: AdapterResult) {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return;
  if (!tokenShape.test(token)) return void result.findings.push(tokenFinding("CLAUDE_CODE_OAUTH_TOKEN in this session has characters that a Claude token does not use, so Fleet did not give it to T3 Code. Set it again from claude setup-token, then run fleet apply."));
  if (!(await realFolders(home))) return void result.findings.push(tokenFinding(`Fleet did not give the Claude token to T3 Code, because a folder on the way to ~/${tokenFile} or ~/${tokenDropIn} is a link or not a folder. Make them plain folders in your home, then run fleet apply.`));
  const file = join(home, tokenFile);
  const dropIn = join(home, tokenDropIn);
  const pending = join(home, pendingFile);
  let present: string | undefined;
  try {
    present = readIfThere(dropIn);
  } catch {
    return void result.findings.push(tokenFinding(`Fleet cannot read ~/${tokenDropIn}, so it leaves that file alone and does not give the Claude token to T3 Code. Make the file readable, or remove it if Fleet wrote it, then run fleet apply.`));
  }
  if (present !== undefined && present !== dropInText) return;
  const wanted = `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
  const written = present === dropInText && readOr(file) === wanted && privateMode(file, 0o600) && privateMode(join(home, tokenFolder), 0o700);
  if (written && lstatSync(pending, { throwIfNoEntry: false }) === undefined) return;
  if (dryRun) return void result.findings.push(tokenFinding("T3 Code's service needs the Claude token that this session has.", "apply"));
  if (!written) {
    mkdirSync(join(home, tokenFolder), { recursive: true, mode: 0o700 });
    chmodSync(join(home, tokenFolder), 0o700);
    await writePrivateFile(pending, needsReload);
    await writePrivateFile(file, wanted);
    mkdirSync(dirname(dropIn), { recursive: true });
    await writePrivateFile(dropIn, dropInText);
    result.actions.push({ target: "t3 claude token", operation: present === undefined ? "create" : "replace" });
  }
  await loadToken(run, env, pending, result);
}

export async function reconcileService(run: CommandRunner, wait: Wait, user: string, dryRun: boolean, result: AdapterResult) {
  const present = async () => (await run(["t3", "--version"])).code === 0;
  let cli = await present();
  if (!cli && dryRun) result.findings.push(finding("cli", "T3 Code needs to be installed from the nightly channel.", "apply"));
  else if (!cli) {
    const version = await newestNightly(run, wait);
    const installed = await retried(() => run(installT3(version)), wait);
    if (installed.code !== 0) return void result.findings.push(finding("cli", `T3 Code did not install (exit ${installed.code}). Run fleet apply again.`, "apply"));
    if (!(await present())) return void result.findings.push(finding("cli", "T3 Code installed, but t3 is not on your PATH. Add ~/.local/bin to PATH, then run fleet apply.", "human"));
    cli = true;
    result.actions.push({ target: "t3", operation: "create", reason: "nightly channel" });
  }
  if ((await run(["systemctl", "--user", "show-environment"])).code !== 0) {
    return void result.findings.push(finding("service", "T3 Code cannot run as a service: systemd's user manager does not answer (systemctl --user). Log in to this machine in a normal session, or install your system's systemd user-session support, then run fleet apply.", "human"));
  }
  const linger = (await run(["loginctl", "show-user", user, "--property=Linger", "--value"])).stdout.trim();
  if (linger === "no" && !dryRun && (await run(["sudo", "-n", "loginctl", "enable-linger", user])).code === 0) result.actions.push({ target: "t3 linger", operation: "create" });
  else if (linger === "no") result.findings.push(finding("linger", `T3 Code stops when you log out, because lingering is off for ${user}. Run: sudo loginctl enable-linger ${user}`, "human"));
  else if (linger !== "yes") result.findings.push(finding("linger", `Fleet cannot tell whether T3 Code keeps running after you log out. Check with: loginctl show-user ${user} --property=Linger`, "human"));
  if (!cli) return void result.findings.push(finding("service", "T3 Code's service needs to be installed.", "apply"));
  const status = await run(["t3", "service", "status"]);
  if (status.code !== 0) return void result.findings.push(finding("service", `Fleet could not read the T3 Code service status (exit ${status.code}). Run t3 service status to see why.`, "human"));
  if (/Status: installed/.test(status.stdout)) return;
  if (/Status: unavailable/.test(status.stdout)) return void result.findings.push(finding("service", "T3 Code says it cannot run as a service on this machine. It needs Linux with systemd.", "human"));
  if (dryRun) return void result.findings.push(finding("service", "T3 Code's service needs to be installed.", "apply"));
  const installed = await run(["t3", "service", "install"]);
  if (installed.code !== 0) return void result.findings.push(finding("service", `t3 service install failed (exit ${installed.code}). Run it yourself to see why, then run fleet apply.`, "apply"));
  result.actions.push({ target: "t3 service", operation: "create" });
}
