import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { changedFiles, writeFiles } from "./managed.ts";
import { readRole } from "./machine.ts";
import { refuseLinks } from "./mcphub/client.ts";
import { dataDir } from "./mcphub/hub.ts";
import type { Run } from "./mcphub/hub.ts";
import { gatewayPort, hostPattern, must, relayPortOf } from "./run.ts";

export type HttpsMode = "plan" | "install" | "doctor";
export type HttpsHub = {
  home: string; httpsHost?: string; relayPort: number; user: string; uid: number;
  caddyInstalled(): boolean; run: Run; sleep(ms: number): Promise<void>; print(line: string): void;
};

const marker = "# Managed by Fleet hub HTTPS.";
const service = "fleet-hub-https.service";
const caddy = "/usr/bin/caddy";
const httpsDir = (home: string) => join(home, ".local/share/fleet-hub-https");
const gateway = `reverse_proxy 127.0.0.1:${gatewayPort}`;

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
  if (!hub.httpsHost) return hub.print("Hub HTTPS is off: hub.httpsHost is empty."), 0;
  if (!hostPattern.test(hub.httpsHost)) throw new Error(`hub.httpsHost is not a host name: ${JSON.stringify(hub.httpsHost)}`);
  if (readRole(hub.home) !== "hub") throw new Error(`fleet hub-https ${mode} runs only on the hub.`);
  const port = relayPortOf(hub.relayPort);
  const origin = `https://${hub.httpsHost}:${port}`;
  if (mode === "plan") return hub.print(`Hub HTTPS plan: private TLS on loopback at ${origin}`), 0;
  for (const name of ["caddy.service", "caddy-api.service"]) {
    for (const check of ["is-active", "is-enabled"]) {
      if ((await hub.run(["systemctl", check, "--quiet", name])).code === 0) throw new Error(`Keep unmanaged system Caddy service ${name}; stop and disable it before you use hub HTTPS.`);
    }
  }
  const systemctl = (...args: string[]) => must(hub.run, ["systemctl", "--user", ...args]);
  if (mode === "install") {
    const config = join(httpsDir(hub.home), "Caddyfile");
    await refuseLinks(hub.home, join(httpsDir(hub.home), "caddy/pki/authorities/local/root.key"), "hub HTTPS path");
    const changed = await changedFiles(hub.home, [{ path: config, content: caddyfile(hub.home, hub.httpsHost, port) }, { path: join(hub.home, ".config/systemd/user", service), content: unit }], marker, "hub HTTPS");
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
