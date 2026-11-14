import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, isolateGit, tempDirs } from "../../src/testing/git.ts";
import { declaredUpstreams } from "../mcp-gateway/lib/declared.ts";
import { dockerHost, fakeHub, fakeMcpHub, fakeRun, mcphubFetch, writeMcpHubSettings } from "../mcp-gateway/lib/testing.ts";
import { registerUpstreams } from "../mcp-gateway/lib/upstreams.ts";
import { contextCommand } from "./commands/context.ts";
import { runGit } from "./lib/git.ts";
import { answer, type Server } from "./mcp/server.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const token = `ghp_${"a1B2".repeat(9)}`;
const decision = `---\ntitle: Canary rollout decision\ntype: decision\ntopics: [canary-rollout]\ndate: 2026-11-02\nsource: https://example.com/doc/1\n---\n\nWe ship the zebra cohort first. Deploy key ${token} stays in the vault.\n`;

function library(files: Record<string, string>) {
  const root = temp.make("context-mcp-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function server(root: string, url?: string) {
  const self: Server = { library: root, url };
  const call = (args: Record<string, unknown>, name = "context_search") => {
    const reply = answer(self, { id: 1, method: "tools/call", params: { name, arguments: args } }) as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { results: Array<Record<string, unknown>> } } };
    return { ...reply.result, text: reply.result.content[0]!.text };
  };
  return { call };
}

test("search reads only the library's own files, refuses paths and commands, removes secrets, and says nothing about a broken library", () => {
  const outside = library({ "secret-plan.md": "---\ntitle: Outside zebra plan\n---\n\nzebra canary outside\n" });
  const root = library({ "decisions/canary.md": decision });
  symlinkSync(join(outside, "secret-plan.md"), join(root, "decisions/linked.md"));
  symlinkSync(outside, join(root, "linked-folder"));
  const { call } = server(root);
  const found = call({ query: "zebra canary", all: true });
  expect(found.structuredContent!.results.map((result) => result.path)).toEqual(["decisions/canary.md"]);
  expect(found.text).not.toContain(token);
  expect(found.text).toContain("Deploy key [redacted GitHub token] stays");
  expect(found.text).not.toContain("outside");
  for (const args of [{ query: "zebra", path: "/etc" }, { query: "z" }, { query: "zebra", limit: 11 }, { query: "zebra", all: "yes" }, { query: 3 }, {}]) {
    const refused = call(args as Record<string, unknown>);
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("Use query (2 to 500 characters), optional all (boolean), and optional limit (integer, 1 to 10). No paths or commands are accepted.");
  }
  expect(call({ query: "zebra" }, "run_command").text).toBe("Only context_search is available. This server cannot write or run commands.");
  const broken = server(join(root, "missing")).call({ query: "zebra canary" });
  expect(broken.isError).toBe(true);
  expect(broken.text).not.toContain(root);
});

test("search neither matches, counts nor shows a secret: a private key's lines or a token past the excerpt's cut", () => {
  const keyBody = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBkZXBsb3kta2V5LWJvZHktbGluZS10d28AAAAAAAAAAAAAAAAAAAAAAAAA";
  const runbook = `---\ntitle: Deploy runbook\n---\n\n${"-----BEGIN"} OPENSSH ${"PRIVATE"} KEY-----\n${keyBody}\n${"-----END"} OPENSSH ${"PRIVATE"} KEY-----\n\nquokka ${"step ".repeat(28)}${token}\n`;
  const { call } = server(library({ "notes/deploy-runbook.md": runbook }));
  expect(call({ query: "QyNTUxOQAAACBkZXBsb3kta2V5" }).structuredContent!.results).toEqual([]);
  const found = call({ query: "quokka" });
  expect(found.structuredContent!.results.map((result) => result.excerpt)).toEqual([expect.stringMatching(/^quokka step/)]);
  expect(found.text).not.toContain("ghp_");
});

test("on the hub, fleet context declares the library's search to the MCP gateway, which runs it under node with the checkout mounted read-only", async () => {
  const base = temp.make("context-hub-");
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(base, "seed");
  git(base, "clone", "-q", remote, seed);
  mkdirSync(join(seed, "decisions"));
  writeFileSync(join(seed, "decisions/canary.md"), decision);
  git(seed, "add", "-A"), git(seed, "commit", "-q", "-m", "seed"), git(seed, "push", "-q", "origin", "HEAD:main");
  const home = join(base, "home");
  mkdirSync(home);
  const printed: string[] = [];
  const settings = { "context-library.repo": `file://${remote}`, "context-library.path": "~/notes", "context-library.url": "https://notes.example.com/blob/main/", "context-library.owner": "" };
  const fleet = (args: string[]) => contextCommand(args, { env: { FLEET_SETTINGS: JSON.stringify(settings) }, home, print: (line) => printed.push(line), git: runGit, agent: () => async () => ({ code: 1, stdout: "", stderr: "" }), today: () => "2026-11-12" });
  expect(await fleet(["sync"])).toBe(0);
  expect(await fleet(["upstream", "doctor"])).toBe(1);
  expect(await fleet(["upstream", "install"])).toBe(0);
  expect(await fleet(["upstream", "doctor"])).toBe(0);
  expect((await declaredUpstreams(home)).map((upstream) => upstream.name)).toEqual(["context"]);

  writeMcpHubSettings(home);
  mkdirSync(join(home, ".local/share/fleet/codex/current/bin"), { recursive: true }), writeFileSync(join(home, ".local/share/fleet/codex/current/bin/codex"), "");
  const api = fakeMcpHub({ groups: [{ id: "g", name: "fleet", servers: [] }] });
  const ran = fakeRun(dockerHost(home, { Config: { Labels: { "org.fleet.service": "mcphub" }, Env: [] }, Image: "sha256:older", State: { Running: true }, Mounts: [] }));
  await registerUpstreams(fakeHub(home, { fetch: mcphubFetch(api), run: ran.run }));
  expect(api.configs.context).toMatchObject({ command: "node", args: ["/fleet-local/context.mjs"], env: { FLEET_CONTEXT_LIBRARY: "/fleet-context", FLEET_CONTEXT_URL: "https://notes.example.com/blob/main/" } });
  expect(ran.calls.filter((call) => call.command[1] === "run").at(-1)!.command.join(" ")).toContain(`-v ${realpathSync(join(home, "notes"))}:/fleet-context:ro`);

  const bundle = join(home, ".local/share/fleet-mcphub/local/context.mjs");
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "context_search", arguments: { query: "zebra canary" } } },
  ];
  const child = Bun.spawn([Bun.which("node") ?? process.execPath, bundle], {
    env: { PATH: process.env.PATH, FLEET_CONTEXT_LIBRARY: join(home, "notes"), FLEET_CONTEXT_URL: "https://notes.example.com/blob/main/" },
    stdin: Buffer.from(messages.map((message) => JSON.stringify(message)).join("\n") + "\n"), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(replies[1].result.structuredContent.results[0]).toMatchObject({ path: "decisions/canary.md", url: "https://notes.example.com/blob/main/decisions/canary.md" });
  expect(stderr).not.toContain("zebra");

  expect(await fleet(["upstream", "remove"])).toBe(0);
  expect(existsSync(join(home, ".config/fleet/mcp-gateway/upstreams/context.json"))).toBe(false);
  expect(await fleet(["upstream", "sideways"])).toBe(2);
});
