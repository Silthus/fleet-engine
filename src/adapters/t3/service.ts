import type { Finding } from "../../pack/types.ts";
import type { AdapterResult } from "../../reconciler/apply.ts";
import type { CommandRunner } from "../run.ts";

export const installT3 = ["/bin/sh", "-c", 'installer=$(mktemp) && curl -fsSL https://t3.codes/install.sh -o "$installer" && T3CODE_CHANNEL=nightly sh "$installer"; code=$?; rm -f "$installer"; exit $code'];

const finding = (id: string, say: string, repair: Finding["repair"]): Finding => ({ id: `t3:${id}`, pack: "engine", say, repair });

/** Installs the nightly t3 CLI and its systemd user service on Linux, the way get.sh installs T3. */
export async function reconcileService(run: CommandRunner, user: string, dryRun: boolean, result: AdapterResult) {
  const present = async () => (await run(["t3", "--version"])).code === 0;
  let cli = await present();
  if (!cli && dryRun) result.findings.push(finding("cli", "T3 Code needs to be installed from the nightly channel.", "apply"));
  else if (!cli) {
    const installed = await run(installT3);
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
