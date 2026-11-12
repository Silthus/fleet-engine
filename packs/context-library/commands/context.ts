import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../base/lib/command.ts";
import { modelFor } from "../../base/lib/models.ts";
import { redactSecrets } from "../../base/hooks/secret-guard.ts";
import { capture, captureAgent, type Agent } from "../lib/capture.ts";
import { cacheFile, librarySettings, writePointer } from "../lib/config.ts";
import { runGit, type Git } from "../lib/git.ts";
import { catalogName, readLibrary, related, renderCatalog, search, topicReport } from "../lib/library.ts";
import { syncLibrary } from "../lib/sync.ts";

type Env = Record<string, string | undefined>;
export type ContextDeps = { env: Env; home: string; print: (line: string) => void; git: Git; agent: () => Agent; today: () => string };

export const usage = `usage:
  fleet context search <word>... [--all]   Rank the library's documents; --all adds superseded ones
  fleet context add <url> [--note <why>]    Save a Slack thread, canvas, Google Doc, meeting, or page as a note
  fleet context related <prompt>            Show what the prompt hook would show for this prompt
  fleet context catalog                     Rewrite CATALOG.md in the library checkout
  fleet context topics                      List topics with three or more documents and whether their hub is stale
  fleet context sync                        Clone the library, or fast-forward it; fails while local changes block that`;

export async function contextCommand(args: string[], deps: ContextDeps): Promise<number> {
  const [mode, ...rest] = args;
  const library = librarySettings(deps.env, deps.home);
  writePointer(deps.home, library);
  const root = library.path;
  const docs = () => readLibrary(root, cacheFile(deps.home));
  if (mode === "sync" && !rest.length) return syncLibrary(library, deps.git, deps.print);
  if (mode === "search" && rest.length) {
    const all = rest.includes("--all");
    const hits = search(docs(), rest.filter((word) => word !== "--all").join(" "), (path) => redactSecrets(readFileSync(join(root, path), "utf8")), { all });
    for (const hit of hits) {
      const facts = [hit.doc.type, hit.doc.date, hit.doc.status === "superseded" ? "superseded" : ""].filter(Boolean).join(", ");
      deps.print(`${join(root, hit.doc.path)}\n  ${hit.doc.title} (${facts})${hit.line ? `\n  ${hit.line}` : ""}`);
    }
    if (!hits.length) deps.print("No document matches every word. Try fewer words, or --all for superseded documents.");
    return 0;
  }
  if (mode === "add" && rest.length) {
    const noteAt = rest.indexOf("--note");
    const source = rest[0]!;
    if (!/^https:\/\//.test(source) || (noteAt >= 0 && noteAt !== 1) || (noteAt < 0 && rest.length !== 1) || rest.length === 2) return deps.print(usage), 2;
    const saved = await capture({ source, via: "cli", note: noteAt >= 0 ? rest.slice(noteAt + 1).join(" ") : undefined }, { home: deps.home, library, agent: deps.agent(), git: deps.git, today: deps.today });
    deps.print(`${saved.updated ? "Updated" : "Saved"} ${saved.title}: ${join(root, saved.path)}\n${saved.url}`);
    return 0;
  }
  if (mode === "related" && rest.length) {
    for (const doc of related(docs(), rest.join(" "))) deps.print(`${join(root, doc.path)}: ${doc.title}`);
    return 0;
  }
  if (mode === "catalog" && !rest.length) {
    writeFileSync(join(root, catalogName), renderCatalog(docs()));
    deps.print(`Wrote ${join(root, catalogName)}.`);
    return 0;
  }
  if (mode === "topics" && !rest.length) {
    for (const topic of topicReport(docs())) {
      deps.print(`${topic.topic}: ${topic.docs.length} documents, hub ${topic.hub ? `${topic.hub.path}${topic.stale ? " (stale)" : ""}` : "missing"}`);
      for (const doc of topic.docs) deps.print(`  ${doc.path}${doc.date ? ` (${doc.date})` : ""}`);
    }
    return 0;
  }
  deps.print(usage);
  return 2;
}

if (import.meta.main) {
  await runCommand(
    () => contextCommand(process.argv.slice(2), {
      env: Bun.env,
      home: Bun.env.HOME ?? homedir(),
      print: (line) => console.log(line),
      git: runGit,
      agent: () => captureAgent(modelFor("survey")),
      today: () => new Date().toISOString().slice(0, 10),
    }),
    "fleet context",
  );
}
