import { afterEach, expect, test } from "bun:test";
import { tempDirs } from "../../../../src/testing/git.ts";
import { logShown } from "../../../memory/lib/notes.ts";
import { writeHome } from "../testing.ts";
import { dreamCommand } from "./command.ts";
import { hubWithSubtree, quietIo } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function claudeSession(home: string, session: string, cwd: string, said: string, answered: string) {
  const lines = [
    { type: "user", sessionId: session, cwd, timestamp: "2026-11-04T10:00:00Z", message: { role: "user", content: said } },
    { type: "assistant", sessionId: session, cwd, timestamp: "2026-11-04T10:05:00Z", message: { model: "m", content: [{ type: "text", text: answered }] } },
  ];
  writeHome(home, { [`.claude/projects/-dev-app/${session}.jsonl`]: lines.map((line) => JSON.stringify(line)).join("\n") });
}

test("digest names the notes that the recall hook showed a session because a call named their trigger", async () => {
  const home = temp.make("fleet-dream-logs-");
  hubWithSubtree(home, { "MEMORY.md": "# Memory index\n" });
  claudeSession(home, "s-1", `${home}/dev/app`, "Prove the PR.", "Proved.");
  logShown(home, { session: "s-1", via: "index", note: "projects/app/INDEX.md" });
  logShown(home, { session: "s-1", via: "trigger", note: "tech/proof-traps.md", trigger: "fleet proof" });
  logShown(home, { session: "s-1", agent: "a-1", via: "trigger", note: "tech/proof-traps.md", trigger: "fleet proof" });
  logShown(home, { session: "s-other", via: "trigger", note: "tech/other.md", trigger: "other" });
  const { io, printed } = quietIo(home);

  expect(await dreamCommand(["digest", "--since", "2d"], io)).toBe(0);

  const [item] = printed.join("").trim().split("\n").map((line) => JSON.parse(line));
  expect([item.session, item.memoryShown]).toEqual(["s-1", ["tech/proof-traps.md"]]);
});

test("logs prints the Dream's own sessions on this machine and leaves the other sessions out", async () => {
  const home = temp.make("fleet-dream-logs-");
  hubWithSubtree(home, { "MEMORY.md": "# Memory index\n" });
  claudeSession(home, "s-dream", `${home}/dev/app`, "Follow the dream skill with the run directory /tmp/run.", "Opened the Dream PR.");
  claudeSession(home, "s-work", `${home}/dev/app`, "Fix the login bug.", "Fixed.");
  const { io, printed } = quietIo(home);

  expect(await dreamCommand(["logs", "--since", "7d"], io)).toBe(0);

  const text = printed.join("");
  expect(text).toContain("[user] Follow the dream skill with the run directory /tmp/run.");
  expect(text).toContain("[assistant] Opened the Dream PR.");
  expect(text).not.toContain("Fix the login bug.");
});

test("logs says so when this machine ran no Dream session in that time", async () => {
  const home = temp.make("fleet-dream-logs-");
  hubWithSubtree(home, { "MEMORY.md": "# Memory index\n" });
  claudeSession(home, "s-work", `${home}/dev/app`, "Fix the login bug.", "Fixed.");
  const { io, printed } = quietIo(home);

  expect(await dreamCommand(["logs"], io)).toBe(0);

  expect(printed).toEqual(["No Dream session in that time on this machine. Run it on the hub."]);
});
