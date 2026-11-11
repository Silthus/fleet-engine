import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, ownedFiles, readIfThere, removeUnits, requireInstalled, writeFiles, type Managed } from "./managed.ts";
import { gatewayPort, refuseLinks, writePrivateFile } from "../../mcp-gateway/lib/client.ts";
import { readRole } from "./machine.ts";
import { onHub } from "../../../src/hub/ssh.ts";
import { dataDir } from "../../mcp-gateway/lib/hub.ts";
import type { Run } from "../../mcp-gateway/lib/hub.ts";
import { hostPattern, must, relayPortOf } from "./run.ts";

export type HttpsMode = "plan" | "install" | "doctor" | "ca" | "trusted" | "remove" | "left";
export type HttpsHub = {
  home: string; alias: string; httpsHost?: string; relayPort: number; user: string; uid: number;
  caddyInstalled(): boolean; run: Run; sleep(ms: number): Promise<void>; print(line: string): void;
};

const marker = "# Managed by Fleet hub HTTPS.";
const service = "fleet-hub-https.service";
const caddy = "/usr/bin/caddy";
const httpsDir = (home: string) => join(home, ".local/share/fleet-hub-https");
const gateway = `reverse_proxy 127.0.0.1:${gatewayPort}`;
const authorityDir = (home: string) => join(httpsDir(home), "caddy/pki/authorities/local");
const certificatePattern = /^(-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n?)+$/;
const caHeading = "Hub HTTPS root certificate: ";

export function caddyfile(home: string, host: string, port: number): string {
  return `${marker}
{
  admin off
  auto_https disable_redirects
  skip_install_trust
}
https://${host}:${port} {
  bind 127.0.0.1
  tls internal {
    on_demand
  }
  handle /mcphub/oauth/callback {
    rewrite * /oauth/callback
    ${gateway}
  }
  handle /mcphub-signin/* {
    root * "${join(dataDir(home), "signin")}"
    uri strip_prefix /mcphub-signin
    file_server
  }
  handle /mcphub/* {
    ${gateway}
  }
  handle /mcphub {
    ${gateway}
  }
  handle /health {
    ${gateway}
  }
  handle {
    reverse_proxy 127.0.0.1:3773
  }
}
`;
}

const unit = `${marker}
[Unit]
Description=Fleet private hub HTTPS
After=network.target

[Service]
ExecStart=${caddy} run --config "%h/.local/share/fleet-hub-https/Caddyfile" --adapter caddyfile
Environment=XDG_DATA_HOME=%h/.local/share/fleet-hub-https
Environment=XDG_CONFIG_HOME=%h/.local/share/fleet-hub-https
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;

export async function hubHttps(mode: HttpsMode, hub: HttpsHub): Promise<number> {
  if (mode === "remove" || mode === "left") return withoutHttps(mode, hub);
  if (!hub.httpsHost) return hub.print("Hub HTTPS is off: hub.httpsHost is empty."), 0;
  if (!hostPattern.test(hub.httpsHost)) throw new Error(`hub.httpsHost is not a host name: ${JSON.stringify(hub.httpsHost)}`);
  if (mode === "trusted") return trusted(hub);
  if (readRole(hub.home) !== "hub") throw new Error(`fleet hub-https ${mode} runs only on the hub.`);
  if (mode === "ca") return printAuthority(hub);
  const port = relayPortOf(hub.relayPort);
  const origin = `https://${hub.httpsHost}:${port}`;
  if (mode === "plan") return hub.print(`Hub HTTPS plan: private TLS on loopback at ${origin}`), 0;
  for (const name of ["caddy.service", "caddy-api.service"]) {
    for (const check of ["is-active", "is-enabled"]) {
      if ((await hub.run(["systemctl", check, "--quiet", name])).code === 0) throw new Error(`Keep unmanaged system Caddy service ${name}; stop and disable it before you use hub HTTPS.`);
    }
  }
  const systemctl = (...args: string[]) => must(hub.run, ["systemctl", "--user", ...args]);
  const config = join(httpsDir(hub.home), "Caddyfile");
  const files: Managed[] = [{ path: config, content: caddyfile(hub.home, hub.httpsHost, port) }, { path: join(hub.home, ".config/systemd/user", service), content: unit }];
  if (mode === "doctor") await requireInstalled(hub.home, files, marker, "hub HTTPS", "fleet hub-https install");
  if (mode === "install") {
    await refuseLinks(hub.home, join(authorityDir(hub.home), "root.key"), "hub HTTPS path");
    const changed = await changedFiles(hub.home, files, marker, "hub HTTPS");
    await mkdir(httpsDir(hub.home), { recursive: true, mode: 0o700 });
    await chmod(httpsDir(hub.home), 0o700);
    await writeFiles(changed);
    if (!hub.caddyInstalled()) {
      await must(hub.run, ["sudo", "-n", "systemctl", "mask", "caddy.service", "caddy-api.service"]);
      await must(hub.run, ["sudo", "-n", "apt-get", "install", "-y", "caddy"]);
    }
    await must(hub.run, [caddy, "validate", "--config", config, "--adapter", "caddyfile"]);
    await must(hub.run, ["sudo", "-n", "loginctl", "enable-linger", hub.user]);
    await must(hub.run, ["sudo", "-n", "systemctl", "start", `user@${hub.uid}.service`]);
    await systemctl("daemon-reload");
    if (changed.length) await systemctl("restart", service);
    await systemctl("enable", "--now", service);
  }
  await systemctl("is-enabled", "--quiet", service);
  await systemctl("is-active", "--quiet", service);
  const address = `127.0.0.1:${port}`;
  const listeners = async () => (await must(hub.run, ["ss", "-H", "-ltn", `sport = :${port}`])).trim().split("\n").filter(Boolean).map((line) => line.split(/\s+/)[3]);
  for (let attempt = 0; mode === "install" && attempt < 50 && !(await listeners()).includes(address); attempt++) await hub.sleep(100);
  const bound = await listeners();
  if (!bound.includes(address) || bound.some((local) => local !== address)) throw new Error(`Hub HTTPS must listen on loopback only, at ${address}.`);
  hub.print(`Hub HTTPS: active at ${origin}`);
  return 0;
}

/** remove takes away the unit and config that install wrote, and keeps the certificate authority that browsers trust, Caddy, and linger. left exits 0 while either file is here. */
async function withoutHttps(mode: "remove" | "left", hub: HttpsHub): Promise<number> {
  const unitPath = join(hub.home, ".config/systemd/user", service);
  const left = await ownedFiles(hub.home, [unitPath, join(httpsDir(hub.home), "Caddyfile")], marker, "hub HTTPS");
  if (mode === "left") return hub.print(left.length ? `Hub HTTPS: ${left.join(", ")} still here.` : "Hub HTTPS: nothing left."), left.length ? 0 : 1;
  await removeUnits(hub.home, [unitPath], marker, "hub HTTPS", hub.run);
  for (const path of left.filter((path) => path !== unitPath)) await rm(path);
  hub.print("Hub HTTPS: removed. Kept its certificate authority, Caddy, and linger.");
  return 0;
}

async function printAuthority(hub: HttpsHub): Promise<number> {
  const path = join(authorityDir(hub.home), "root.crt");
  await refuseLinks(hub.home, path, "hub HTTPS path");
  const text = await readIfThere(path);
  if (text === undefined) throw new Error("Hub HTTPS has no root certificate yet. Run fleet hub-https install.");
  if (!certificatePattern.test(text)) throw new Error(`${path} is not a public certificate.`);
  hub.print(`${caHeading}${path}`);
  hub.print(text.trimEnd());
  return 0;
}

const trustProbeLimitMs = 60_000;

async function trusted(hub: HttpsHub): Promise<number> {
  const answer = await hub.run(onHub(hub.alias, ["hub-https", "ca"]), { timeoutMs: trustProbeLimitMs });
  const certificate = answer.code === 0 ? answer.stdout.split("\n").filter((line) => !line.startsWith(caHeading)).join("\n").trim() + "\n" : "";
  if (!certificatePattern.test(certificate)) return hub.print(`${hub.alias} gave no public root certificate: ${(answer.stderr || answer.stdout).trim()}`), 1;
  const folder = await mkdtemp(join(tmpdir(), "fleet-hub-ca-"));
  try {
    const path = join(folder, "hub-ca.crt");
    await writePrivateFile(path, certificate);
    return (await hub.run(["security", "verify-cert", "-l", "-L", "-p", "ssl", "-c", path], { timeoutMs: trustProbeLimitMs })).code === 0 ? 0 : 1;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
