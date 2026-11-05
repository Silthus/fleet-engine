import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../../src/testing/git.ts";
import { clientPath, localGatewayUrl } from "./client.ts";
import { runMcphub, type McphubDeps } from "./command.ts";
import { fakeHub, writeMachineFile, writeMcpHubSettings } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const token = "mcphub_secret-token";

function deps(home: string, fields: Partial<McphubDeps> = {}) {
  const written: string[] = [];
  const failed: string[] = [];
  const stdin = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const all = { ...fakeHub(home), stdin, write: (line: string) => { written.push(line); }, fail: (line: string) => { failed.push(line); }, ...fields };
  return { deps: all, written, failed, printed: all.printed };
}

function withClient(client: unknown) {
  const home = temp.make("fleet-mcphub-command-");
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(clientPath(home), JSON.stringify(client));
  return home;
}

test("names every mode when the arguments are wrong", async () => {
  const run = deps(temp.make("fleet-mcphub-command-"));
  for (const args of [["cutover"], ["connect", "box-1"], ["grant"], ["reconnect"], ["install", "now"]]) expect(await runMcphub(args, run.deps)).toBe(2);
  expect(new Set(run.failed)).toEqual(new Set(["Use fleet mcphub install|doctor|restart|links|check|connect, fleet mcphub reconnect <server>, or fleet mcphub grant <machine>."]));
});

test("connect without a key on this machine exits with one line that says what to run on the hub", async () => {
  const run = deps(temp.make("fleet-mcphub-command-"));
  expect(await runMcphub(["connect"], run.deps)).toBe(1);
  expect(run.failed).toEqual(["This machine has no MCP gateway key. On the hub, run: fleet mcphub grant <this machine's SSH name>"]);
  expect(run.written).toEqual([]);
});

test("connect refuses a key file for another address without printing the key", async () => {
  const run = deps(withClient({ baseUrl: "https://elsewhere.example.com:60001/mcphub", token }));
  expect(await runMcphub(["connect"], run.deps)).toBe(1);
  expect(run.failed).toEqual(["~/.config/fleet/mcphub.client.json is not a key from your hub. On the hub, run: fleet mcphub grant <this machine's SSH name>"]);
});

test("connect relays until the agent closes stdin", async () => {
  const run = deps(withClient({ baseUrl: localGatewayUrl, token }), { fetch: async () => { throw new TypeError("unused"); } });
  expect(await runMcphub(["connect"], run.deps)).toBe(0);
  expect(run.failed).toEqual([]);
});

test("check prints its verdict and exits non-zero when the gateway does not answer", async () => {
  const down = deps(withClient({ baseUrl: localGatewayUrl, token }), { fetch: async () => { throw new TypeError("refused"); } });
  expect(await runMcphub(["check"], down.deps)).toBe(1);
  expect(down.failed).toEqual(["The MCP gateway at http://127.0.0.1:3317/mcphub does not answer. On the hub, run: fleet mcphub doctor"]);
  const up = deps(withClient({ baseUrl: localGatewayUrl, token }), { fetch: async () => new Response("{}") });
  expect(await runMcphub(["check"], up.deps)).toBe(0);
  expect(up.printed).toEqual(["The MCP gateway at http://127.0.0.1:3317/mcphub answers."]);
});

test("accept saves the key the hub sends on stdin", async () => {
  const home = temp.make("fleet-mcphub-command-");
  const body = new TextEncoder().encode(JSON.stringify({ baseUrl: localGatewayUrl, token }));
  const run = deps(home, { stdin: new ReadableStream({ start: (controller) => (controller.enqueue(body), controller.close()) }) });
  expect(await runMcphub(["accept"], run.deps)).toBe(0);
  expect(JSON.parse(readFileSync(clientPath(home), "utf8"))).toEqual({ baseUrl: localGatewayUrl, token });
  expect(run.printed).toEqual(["Saved the MCP gateway key."]);
});

test("runs doctor without arguments, and exits non-zero when it fails", async () => {
  const home = temp.make("fleet-mcphub-command-");
  writeMachineFile(home, "hub");
  const run = deps(home);
  expect(await runMcphub([], run.deps)).toBe(1);
  expect(run.printed).toEqual(["MCPHub is not installed. Run: fleet mcphub install"]);
  writeMcpHubSettings(home);
  expect(await runMcphub(["doctor"], deps(home).deps)).toBe(1);
});
