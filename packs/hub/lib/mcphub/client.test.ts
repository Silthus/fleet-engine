import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../../src/testing/git.ts";
import { checkGateway, clientPath, devboxGatewayUrl, localGatewayUrl, readGatewayClient, saveGatewayClient, writePrivateFile } from "./client.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const secure = { httpsHost: "hub.internal.example.com", relayPort: 60001 };
const tunnelled = { relayPort: 60001 };
const token = "mcphub_test-token";

function home(client?: unknown) {
  const dir = temp.make("fleet-mcphub-client-");
  if (client !== undefined) {
    mkdirSync(join(dir, ".config/fleet"), { recursive: true });
    writeFileSync(clientPath(dir), JSON.stringify(client));
  }
  return dir;
}

test("a devbox reaches the gateway over HTTPS when the hub has a host name, and through the SSH tunnel otherwise", () => {
  expect(devboxGatewayUrl(secure)).toBe("https://hub.internal.example.com:60001/mcphub");
  expect(devboxGatewayUrl(tunnelled)).toBe(localGatewayUrl);
  expect(localGatewayUrl).toBe("http://127.0.0.1:3317/mcphub");
});

test("the client file accepts exactly the hub's HTTPS address and the loopback address", async () => {
  for (const baseUrl of [localGatewayUrl, "https://hub.internal.example.com:60001/mcphub"]) {
    expect(await readGatewayClient(home({ baseUrl, token }), secure)).toEqual({ baseUrl, token });
  }
  const refused = ["http://hub.test:3317/mcphub", "http://127.0.0.2:3317/mcphub", "http://localhost:3317/mcphub", "http://127.0.0.1:60001/mcphub",
    "http://127.0.0.1:3317/mcphub?token=test", "http://user:secret@127.0.0.1:3317/mcphub", "http://127.0.0.1:3317/mcphub\n",
    "https://other.example.com:60001/mcphub", "https://hub.internal.example.com:60002/mcphub", "http://hub.internal.example.com:60001/mcphub"];
  for (const baseUrl of refused) await expect(readGatewayClient(home({ baseUrl, token }), secure)).rejects.toThrow("is not a key from your hub");
  await expect(readGatewayClient(home({ baseUrl: "https://hub.internal.example.com:60001/mcphub", token }), tunnelled)).rejects.toThrow("is not a key from your hub");
  await expect(readGatewayClient(home({ baseUrl: localGatewayUrl, token: "has space" }), secure)).rejects.toThrow("is not a key from your hub");
});

test("an old client file with the dropped cutover flag still reads", async () => {
  expect(await readGatewayClient(home({ baseUrl: localGatewayUrl, token, cutover: true }), secure)).toEqual({ baseUrl: localGatewayUrl, token });
});

test("reads no client when the machine has no key yet", async () => {
  expect(await readGatewayClient(home(), secure)).toBeUndefined();
});

test("saves a key as a private file, replacing an older one", async () => {
  const dir = home({ baseUrl: localGatewayUrl, token: "old-token" });
  await saveGatewayClient(dir, { baseUrl: "https://hub.internal.example.com:60001/mcphub", token }, secure);
  expect(JSON.parse(readFileSync(clientPath(dir), "utf8"))).toEqual({ baseUrl: "https://hub.internal.example.com:60001/mcphub", token });
  expect(statSync(clientPath(dir)).mode & 0o777).toBe(0o600);
});

test("replaces a world-readable key file with a new private file, and never writes the old one", async () => {
  const dir = home({ baseUrl: localGatewayUrl, token: "old-token" });
  chmodSync(clientPath(dir), 0o644);
  const old = join(dir, "old-key-inode");
  linkSync(clientPath(dir), old);
  await saveGatewayClient(dir, { baseUrl: localGatewayUrl, token }, secure);
  expect(readFileSync(old, "utf8")).not.toContain(token);
  expect(statSync(old).mode & 0o777).toBe(0o644);
  expect(statSync(clientPath(dir)).ino).not.toBe(statSync(old).ino);
  expect(statSync(clientPath(dir)).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(dir, ".config/fleet")).sort()).toEqual(["mcphub.client.json"]);
});

test("refuses to save a key through a linked config folder or to an address that is not the hub's", async () => {
  const dir = home();
  const outside = temp.make("fleet-mcphub-outside-");
  mkdirSync(join(dir, ".config"));
  symlinkSync(outside, join(dir, ".config/fleet"));
  await expect(saveGatewayClient(dir, { baseUrl: localGatewayUrl, token }, secure)).rejects.toThrow("linked");
  await expect(saveGatewayClient(home(), { baseUrl: "https://elsewhere.example.com:60001/mcphub", token }, secure)).rejects.toThrow("is not a key from your hub");
});

test("the check passes when the key exists and the gateway answers its health endpoint", async () => {
  const asked: string[] = [];
  const fetch = async (url: string | URL | Request) => (asked.push(String(url)), new Response("{}", { status: 200 }));
  const result = await checkGateway(home({ baseUrl: "https://hub.internal.example.com:60001/mcphub", token }), secure, fetch);
  expect(result).toEqual({ ok: true, line: "The MCP gateway at https://hub.internal.example.com:60001/mcphub answers." });
  expect(asked).toEqual(["https://hub.internal.example.com:60001/health"]);
});

test("the check says what to run on the hub when the key is missing or the gateway does not answer, and never shows the key", async () => {
  const down = async () => { throw new TypeError("connection refused"); };
  const sick = async () => new Response("", { status: 503 });
  const missing = await checkGateway(home(), secure, down);
  expect(missing).toEqual({ ok: false, line: "This machine has no MCP gateway key. On the hub, run: fleet mcphub grant <this machine's SSH name>" });
  for (const fetch of [down, sick]) {
    const result = await checkGateway(home({ baseUrl: localGatewayUrl, token }), secure, fetch);
    expect(result.ok).toBe(false);
    expect(result.line).toStartWith("The MCP gateway at http://127.0.0.1:3317/mcphub does not answer. On the hub, run: fleet mcphub doctor");
    expect(result.line).not.toContain(token);
  }
  const invalid = await checkGateway(home({ baseUrl: "https://elsewhere.example.com/mcphub", token }), secure, down);
  expect(invalid.line).toBe("~/.config/fleet/mcphub.client.json is not a key from your hub. On the hub, run: fleet mcphub grant <this machine's SSH name>");
});

test("leaves no temporary file behind when writing a private file fails", async () => {
  const dir = temp.make("private-");
  const unwritable = { toString: () => { throw new Error("cannot write"); } } as unknown as string;
  await expect(writePrivateFile(join(dir, "key.json"), unwritable)).rejects.toThrow();
  expect(readdirSync(dir)).toEqual([]);
});
