import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub, RunResult } from "./hub.ts";

export const managementToken = "management-token";

export type ApiCall = { method: string; path: string; body?: Record<string, unknown> };
export type FakeMcpHub = {
  servers: string[];
  groups: Array<{ id: string; name: string; servers: string[] }>;
  calls: ApiCall[];
  healthy: boolean;
  openWithoutKey: boolean;
  notReadyFor: number;
  home?: string;
};

export function fakeMcpHub(fields: Partial<FakeMcpHub> = {}): FakeMcpHub {
  return { servers: ["tickets", "calendar"], groups: [], calls: [], healthy: true, openWithoutKey: false, notReadyFor: 0, ...fields };
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
    root: join(import.meta.dir, "../.."),
    platform: "linux",
    uid: 1000,
    gid: 1000,
    alias: () => "my-hub",
    devboxes: async () => ["box-1", "box-2"],
    gateway: { httpsHost: "hub.internal.example.com", relayPort: 60001 },
    run: fakeRun().run,
    fetch: mcphubFetch(fakeMcpHub({ home })),
    sleep: async () => {},
    print: (line) => { printed.push(line); },
    printed,
    ...fields,
  };
}
