import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub, RunResult } from "./hub.ts";

export const managementToken = "management-token";

export type ApiCall = { method: string; path: string; body?: Record<string, unknown> };
export type FakeMcpHub = {
  servers: string[];
  configs: Record<string, Record<string, unknown>>;
  keepsConfig: boolean;
  groups: Array<{ id: string; name: string; servers: string[] }>;
  calls: ApiCall[];
  healthy: boolean;
  openWithoutKey: boolean;
  notReadyFor: number;
  home?: string;
};

export function fakeMcpHub(fields: Partial<FakeMcpHub> = {}): FakeMcpHub {
  return { servers: ["tickets", "calendar"], configs: {}, keepsConfig: true, groups: [], calls: [], healthy: true, openWithoutKey: false, notReadyFor: 0, ...fields };
}

function keyOf(state: FakeMcpHub) {
  if (!state.home) return managementToken;
  const settings = JSON.parse(readFileSync(join(state.home, ".local/share/fleet-mcphub/data/mcp_settings.json"), "utf8")) as { bearerKeys: Array<{ id: string; token: string }> };
  return settings.bearerKeys.find((key) => key.id === "fleet-management")!.token;
}

export function mcphubFetch(state: FakeMcpHub) {
  return async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const authorized = new Headers(init.headers).get("authorization") === `Bearer ${keyOf(state)}`;
    if (url.origin !== "http://127.0.0.1:3317") throw new TypeError("unexpected host");
    if (url.pathname === "/health") return new Response(null, { status: state.healthy ? 200 : 503 });
    if (url.pathname === "/mcphub/mcp") return new Response(null, { status: authorized || state.openWithoutKey ? 200 : 401 });
    if (!url.pathname.startsWith("/mcphub/api/")) return new Response(null, { status: 404 });
    if (state.notReadyFor > 0) { state.notReadyFor--; throw new TypeError("connection refused"); }
    if (!authorized) return new Response(null, { status: 401 });
    const path = url.pathname.slice("/mcphub/api/".length);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    state.calls.push({ method, path, ...(body ? { body } : {}) });
    if (method === "GET" && path === "servers") return Response.json({ success: true, data: state.servers.map((name) => ({ name, status: "connected", tools: [{}, {}] })) });
    if (method === "GET" && path === "groups") return Response.json({ success: true, data: state.groups });
    if (method === "POST" && path === "groups") {
      const group = { id: `group-${state.groups.length + 1}`, name: String(body!.name), servers: body!.servers as string[] };
      state.groups.push(group);
      return Response.json({ success: true, data: group }, { status: 201 });
    }
    const group = path.match(/^groups\/(.+)$/);
    if (method === "PUT" && group) {
      const found = state.groups.find((item) => item.id === decodeURIComponent(group[1]!));
      if (!found) return new Response(null, { status: 404 });
      found.servers = body!.servers as string[];
      return Response.json({ success: true, data: found });
    }
    if (method === "POST" && path === "auth/keys") return Response.json({ success: true, data: { id: "key-new", token: "mcphub_new-machine-token", ...body } }, { status: 201 });
    if (method === "PUT" && path.startsWith("auth/keys/")) return Response.json({ success: true, data: body });
    if (method === "POST" && /^servers\/[^/]+\/reload$/.test(path)) return Response.json({ success: true });
    const server = path.match(/^servers\/([^/]+)$/);
    const name = server ? decodeURIComponent(server[1]!) : String(body?.name);
    const stored = (config: Record<string, any>) => {
      const { startOnDemand, options, ...rest } = config;
      const kept = { ...options };
      delete kept.startOnDemand;
      state.configs[name] = state.keepsConfig ? { ...rest, type: "stdio", ...(Object.keys(kept).length && { options: kept }), ...(startOnDemand === true && { startOnDemand: true }) } : { type: "stdio" };
    };
    if (method === "POST" && path === "servers") {
      if (state.servers.includes(name)) return new Response(null, { status: 400 });
      state.servers.push(name), stored(body!.config as Record<string, unknown>);
      return Response.json({ success: true }, { status: 201 });
    }
    if (!server || !state.servers.includes(name)) return new Response(null, { status: 404 });
    if (method === "GET") return Response.json({ success: true, data: { name, status: "connected", tools: [], config: state.configs[name] ?? {} } });
    if (method === "PUT") return stored(body!.config as Record<string, unknown>), Response.json({ success: true });
    return new Response(null, { status: 404 });
  };
}

export type RunCall = { command: string[]; cwd?: string; input?: string };

export function fakeRun(answer: (call: RunCall) => Partial<RunResult> = () => ({})) {
  const calls: RunCall[] = [];
  const run = async (command: string[], options: { cwd?: string; input?: string } = {}): Promise<RunResult> => {
    const call = { command, ...options };
    calls.push(call);
    return { code: 0, stdout: "", stderr: "", ...answer(call) };
  };
  return { calls, run };
}

export function writeMcpHubSettings(home: string, settings: Record<string, unknown> = {}) {
  const dir = join(home, ".local/share/fleet-mcphub/data");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mcp_settings.json"), JSON.stringify({
    mcpServers: { tickets: {}, "calendar": {} },
    systemConfig: { install: { baseUrl: "http://127.0.0.1:3317/mcphub" } },
    bearerKeys: [{ id: "fleet-management", name: "Fleet local management", token: managementToken, enabled: true, kind: "system", accessType: "all" }],
    ...settings,
  }));
}

export function writeMachineFile(home: string, role: string) {
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role }));
}

export function fakeHub(home: string, fields: Partial<Hub> = {}): Hub & { printed: string[] } {
  const printed: string[] = [];
  return {
    home,
    root: join(import.meta.dir, ".."),
    platform: "linux",
    uid: 1000,
    gid: 1000,
    hubName: () => "my-hub",
    devboxes: async () => ["box-1", "box-2"],
    gateway: {},
    run: fakeRun().run,
    fetch: mcphubFetch(fakeMcpHub({ home })),
    sleep: async () => {},
    print: (line) => { printed.push(line); },
    printed,
    ...fields,
  };
}

export const environmentOf = (home: string) => readFileSync(join(home, ".local/share/fleet-mcphub/runtime.env"), "utf8").split("\n").filter(Boolean);
const mounts = (command: string[]) => command.flatMap((arg, index) => (command[index - 1] === "-v" ? [{ Destination: arg.split(":")[1]! }] : []));

export type FakeContainer = { Config: { Labels: Record<string, string>; Env: string[] }; Image: string; State: { Running: boolean }; Mounts: Array<{ Destination: string }> };

export function dockerHost(home: string, start?: FakeContainer) {
  let container = start;
  const answer = (call: RunCall) => {
    const [tool, noun, verb] = call.command;
    if (tool !== "docker") return {};
    if (noun === "container" && verb === "inspect") return container ? { stdout: JSON.stringify([container]) } : { code: 1, stderr: "No such container" };
    if (noun === "image" && verb === "inspect") return { stdout: JSON.stringify([{ Id: `sha256:${call.command[3]}` }]) };
    if (noun === "run") {
      const labels = Object.fromEntries(call.command.flatMap((arg, index) => (call.command[index - 1] === "--label" ? [arg.split("=")] : [])));
      container = { Config: { Labels: { ...labels, "org.fleet.patch": "1.1.0-elicitation" }, Env: [...environmentOf(home), "PATH=/usr/local/bin"] }, Image: `sha256:${call.command.at(-2)}`, State: { Running: true }, Mounts: mounts(call.command) };
    }
    if (noun === "stop") container!.State.Running = false;
    if (noun === "rm") container = undefined;
    return {};
  };
  return Object.assign(answer, { container: () => container });
}
