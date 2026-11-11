import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFile } from "../../files/private.ts";
import type { Finding } from "../../pack/types.ts";
import type { AdapterResult } from "../../reconciler/apply.ts";
import type { CommandRunner } from "../run.ts";

export type Wait = (ms: number) => Promise<void>;

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

const tokenFile = ".config/claude-env/oauth.env";
const tokenDropIn = ".config/systemd/user/t3code.service.d/claude-token.conf";
const dropInText = `[Service]\nEnvironmentFile=%h/${tokenFile}\n`;

const readOr = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** T3 Code's user service does not inherit the session, so a Claude token that the session gets from its environment reaches T3 through a file. A drop-in that Fleet did not write stays. */
export async function reconcileClaudeToken(run: CommandRunner, home: string, token: string | undefined, dryRun: boolean, result: AdapterResult) {
  if (!token) return;
  const file = join(home, tokenFile);
  const dropIn = join(home, tokenDropIn);
  const present = readOr(dropIn);
  if (present !== undefined && present !== dropInText) return;
  const wanted = `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
  if (present === dropInText && readOr(file) === wanted && (lstatSync(file).mode & 0o777) === 0o600) return;
  if (dryRun) return void result.findings.push(finding("claude-token", "T3 Code's service needs the Claude token that this session has.", "apply"));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  await writePrivateFile(file, wanted);
  mkdirSync(dirname(dropIn), { recursive: true });
  await writePrivateFile(dropIn, dropInText);
  const reloaded = (await run(["systemctl", "--user", "daemon-reload"])).code === 0 && (await run(["systemctl", "--user", "try-restart", "t3code.service"])).code === 0;
  if (!reloaded) return void result.findings.push(finding("claude-token", "T3 Code did not restart with the new Claude token. Run: systemctl --user daemon-reload && systemctl --user restart t3code.service", "human"));
  result.actions.push({ target: "t3 claude token", operation: present === undefined ? "create" : "replace" });
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
  if (linger === "no") result.findings.push(finding("linger", `T3 Code stops when you log out, because lingering is off for ${user}. Run: sudo loginctl enable-linger ${user}`, "human"));
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
