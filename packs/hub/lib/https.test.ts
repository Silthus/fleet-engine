import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { caddyfile, hubHttps, type HttpsHub } from "./https.ts";
import { fakeRun, modeOf, roleHome } from "./run-testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const host = "hub.internal.example.com";

function hub(fields: Partial<HttpsHub> & { listening?: string; waits?: number } = {}) {
  const home = fields.home ?? roleHome(temp.make("fleet-https-"), "hub");
  let checks = 0;
  const fake = fakeRun((command) => {
    if (command[0] === "systemctl" && command[1] !== "--user") return { code: 1 };
    if (command[0] === "ss") return { stdout: ++checks > (fields.waits ?? 2) ? (fields.listening ?? `LISTEN 0 4096 127.0.0.1:60002 0.0.0.0:*\n`) : "" };
    return undefined;
  });
  const printed: string[] = [];
  const slept: number[] = [];
  const { listening: _listening, waits: _waits, ...overrides } = fields;
  const deps: HttpsHub = { home, httpsHost: host, relayPort: 60002, user: "me", uid: 1000, caddyInstalled: () => true, run: fake.run, sleep: async (ms) => void slept.push(ms), print: (line) => printed.push(line), ...overrides };
  return { deps, home, calls: fake.calls, printed, slept };
}

const config = (home: string) => join(home, ".local/share/fleet-hub-https/Caddyfile");
const unit = (home: string) => join(home, ".config/systemd/user/fleet-hub-https.service");

test("the HTTPS config serves only loopback at hub.httpsHost and hub.relayPort with renewable private TLS", () => {
  const text = caddyfile("/home/me", host, 60002);
  expect(text).toContain(`https://${host}:60002 {`);
  expect(text).toContain("bind 127.0.0.1");
  expect(text).toContain("tls internal {\n    on_demand\n  }");
  expect(text).toContain("admin off");
  expect(text).not.toContain("60001");
});

test("the HTTPS config forwards the gateway, its OAuth callback, its sign-in pages, its health check and T3, but no proxy", () => {
  const text = caddyfile("/home/me", host, 60002);
  expect(text).toContain("handle /health {\n    reverse_proxy 127.0.0.1:3317\n  }");
  expect(text).toContain("handle /mcphub/* {\n    reverse_proxy 127.0.0.1:3317\n  }");
  expect(text).toContain("handle /mcphub {\n    reverse_proxy 127.0.0.1:3317\n  }");
  expect(text).toContain("handle /mcphub/oauth/callback {\n    rewrite * /oauth/callback\n    reverse_proxy 127.0.0.1:3317\n  }");
  expect(text).toContain(`root * "/home/me/.local/share/fleet-mcphub/signin"`);
  expect(text).toContain("reverse_proxy 127.0.0.1:3773");
  expect(text).not.toMatch(/8317|\/v1|management/);
});

test("install writes the config and unit with mode 600 in a private folder, starts the unit, and waits for the loopback listener on the injected clock", async () => {
  const { deps, home, calls, slept, printed } = hub();
  expect(await hubHttps("install", deps)).toBe(0);
  expect(readFileSync(config(home), "utf8")).toBe(caddyfile(home, host, 60002));
  expect(readFileSync(unit(home), "utf8")).toContain("Restart=always");
  expect([modeOf(statSync(config(home))), modeOf(statSync(unit(home))), modeOf(statSync(join(home, ".local/share/fleet-hub-https")))]).toEqual(["600", "600", "700"]);
  expect(calls).toContain(`/usr/bin/caddy validate --config ${config(home)} --adapter caddyfile`);
  expect(calls).toContain("sudo -n loginctl enable-linger me");
  expect(calls).toContain("systemctl --user restart fleet-hub-https.service");
  expect(calls).toContain("systemctl --user enable --now fleet-hub-https.service");
  expect(calls.filter((call) => call.startsWith("ss ")).length).toBe(4);
  expect(slept).toEqual([100, 100]);
  expect(printed.at(-1)).toBe(`Hub HTTPS: active at https://${host}:60002`);
});

test("a second install with nothing changed does not restart Caddy", async () => {
  const { deps } = hub();
  await hubHttps("install", deps);
  const again = hub({ home: deps.home, listening: "LISTEN 0 4096 127.0.0.1:60002 0.0.0.0:*\n" });
  expect(await hubHttps("install", again.deps)).toBe(0);
  expect(again.calls).not.toContain("systemctl --user restart fleet-hub-https.service");
});

test("install puts Caddy in only when it is missing, and masks the packaged system service first", async () => {
  const { deps, calls } = hub({ caddyInstalled: () => false });
  await hubHttps("install", deps);
  const mask = calls.indexOf("sudo -n systemctl mask caddy.service caddy-api.service");
  expect(mask).toBeGreaterThanOrEqual(0);
  expect(calls.indexOf("sudo -n apt-get install -y caddy")).toBe(mask + 1);
  expect(hub().calls.some((call) => call.includes("apt-get"))).toBe(false);
});

test("install keeps an unmanaged system Caddy service and stops", async () => {
  const home = roleHome(temp.make("fleet-https-"), "hub");
  const { run, calls } = fakeRun((command) => (command.join(" ") === "systemctl is-active --quiet caddy.service" ? { code: 0 } : command[0] === "systemctl" && command[1] !== "--user" ? { code: 1 } : undefined));
  await expect(hubHttps("install", { ...hub({ home }).deps, run })).rejects.toThrow("Keep unmanaged system Caddy");
  expect(existsSync(config(home))).toBe(false);
  expect(calls.some((call) => call.startsWith("systemctl --user"))).toBe(false);
});

test("a changed host name replaces Fleet's own config, but a file Fleet did not write stays", async () => {
  const { deps, home } = hub();
  await hubHttps("install", deps);
  await hubHttps("install", { ...hub({ home }).deps, httpsHost: "other.internal.example.com" });
  expect(readFileSync(config(home), "utf8")).toContain("https://other.internal.example.com:60002 {");
  writeFileSync(unit(home), "[Service]\nExecStart=/usr/bin/caddy\n");
  await expect(hubHttps("install", hub({ home }).deps)).rejects.toThrow(`Keep unmanaged hub HTTPS file: ${unit(home)}`);
  expect(readFileSync(unit(home), "utf8")).toBe("[Service]\nExecStart=/usr/bin/caddy\n");
});

test("install refuses symlinked paths and writes nothing through them", async () => {
  const home = roleHome(temp.make("fleet-https-"), "hub");
  const elsewhere = temp.make("fleet-elsewhere-");
  mkdirSync(join(home, ".local/share/fleet-hub-https"), { recursive: true });
  symlinkSync(join(elsewhere, "Caddyfile"), config(home));
  await expect(hubHttps("install", hub({ home }).deps)).rejects.toThrow("Keep linked hub HTTPS path");
  expect(existsSync(join(elsewhere, "Caddyfile"))).toBe(false);
  const other = roleHome(temp.make("fleet-https-"), "hub");
  mkdirSync(join(other, ".local/share/fleet-hub-https/caddy/pki/authorities"), { recursive: true });
  symlinkSync(elsewhere, join(other, ".local/share/fleet-hub-https/caddy/pki/authorities/local"));
  await expect(hubHttps("install", hub({ home: other }).deps)).rejects.toThrow("Keep linked hub HTTPS path");
});

test("with hub.httpsHost empty, every mode does nothing and passes, on any machine", async () => {
  for (const mode of ["plan", "install", "doctor"] as const) {
    const { deps, calls, printed } = hub({ home: roleHome(temp.make("fleet-https-"), "devbox"), httpsHost: undefined });
    expect(await hubHttps(mode, deps)).toBe(0);
    expect(calls).toEqual([]);
    expect(printed).toEqual(["Hub HTTPS is off: hub.httpsHost is empty."]);
  }
});

test("hub HTTPS runs only on the hub", async () => {
  const { deps, calls } = hub({ home: roleHome(temp.make("fleet-https-"), "devbox") });
  await expect(hubHttps("install", deps)).rejects.toThrow("fleet hub-https install runs only on the hub");
  expect(calls).toEqual([]);
});

test("doctor fails when Caddy listens anywhere but loopback, and rejects a host name that is not one", async () => {
  const { deps } = hub();
  await hubHttps("install", deps);
  const open = hub({ home: deps.home, waits: 0, listening: "LISTEN 0 4096 127.0.0.1:60002 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:60002 0.0.0.0:*\n" });
  await expect(hubHttps("doctor", open.deps)).rejects.toThrow("must listen on loopback only");
  await expect(hubHttps("plan", hub({ httpsHost: "bad host\nExecStart=x" }).deps)).rejects.toThrow("hub.httpsHost is not a host name");
});
