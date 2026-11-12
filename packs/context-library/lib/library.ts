import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../../base/hooks/secret-guard.ts";

export const catalogName = "CATALOG.md";
export const hubFolder = "topics";

export type Doc = {
  path: string;
  title: string;
  type: string;
  date?: string;
  topics: string[];
  source?: string;
  series?: string;
  status: "current" | "superseded";
  terms: string[];
};

const skippedFolders = new Set(["node_modules", "qa-ledgers", "proof", "runs"]);
const stopwords = new Set(
  ("about after again also before being between both could does doing during each from have here into just more most other over same should some such than that their them then there these they this those through under until very what when where which while with would your" +
    " notes note research brief briefs draft final index readme plan plans personal context library").split(/\s+/),
);
const folderTypes: Record<string, string> = { research: "research", briefs: "brief", notes: "note", [hubFolder]: "hub" };
const headLimit = 4000;

const frontmatterOf = (text: string) => /^---\n([\s\S]*?)\n---\n?/.exec(text)?.[1] ?? "";
const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "").trim();

export function field(text: string, name: string): string | undefined {
  const match = new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, "m").exec(frontmatterOf(text));
  return unquote(match?.[1] ?? "") || undefined;
}

export function listField(text: string, name: string): string[] {
  const block = frontmatterOf(text);
  const inline = new RegExp(`^\\s*${name}:[ \\t]*\\[(.*)\\][ \\t]*$`, "m").exec(block);
  if (inline) return inline[1]!.split(",").map(unquote).filter(Boolean);
  const start = new RegExp(`^\\s*${name}:[ \\t]*$`, "m").exec(block);
  if (!start) return [];
  const items: string[] = [];
  for (const line of block.slice(start.index + start[0].length).split("\n").slice(1)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (!item) break;
    items.push(unquote(item[1]!));
  }
  return items.filter(Boolean);
}

export function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((word) => word.length >= 4 && !stopwords.has(word) && !/^\d+$/.test(word));
}

function markdownFiles(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return entry.name.startsWith(".") || skippedFolders.has(entry.name) ? [] : markdownFiles(root, path);
    return entry.isFile() && entry.name.endsWith(".md") && path !== catalogName && !/^(AGENTS|CLAUDE|README)\.md$/.test(path) ? [path] : [];
  });
}

export function parseDoc(path: string, text: string): Doc {
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  const name = path.split("/").pop()!.replace(/\.md$/, "");
  const folder = path.includes("/") ? path.split("/")[0]! : "";
  const topics = listField(text, "topics").map((topic) => topic.toLowerCase());
  const terms = [...new Set([...topics.flatMap(words), ...words(name), ...words(folder), ...words(heading ?? "")])];
  return {
    path,
    title: field(text, "title") ?? heading ?? name,
    type: field(text, "type") ?? folderTypes[folder] ?? "doc",
    date: field(text, "date") ?? /\d{4}-\d{2}-\d{2}/.exec(path)?.[0],
    topics,
    source: field(text, "source"),
    series: field(text, "series"),
    status: field(text, "status") === "superseded" ? "superseded" : "current",
    terms,
  };
}

function markSeries(docs: Doc[]): Doc[] {
  const newest = new Map<string, string>();
  for (const doc of docs) if (doc.series && (doc.date ?? "") > (newest.get(doc.series) ?? "")) newest.set(doc.series, doc.date ?? "");
  return docs.map((doc) => (doc.series && (doc.date ?? "") < (newest.get(doc.series) ?? "") ? { ...doc, status: "superseded" } : doc));
}

const parseAll = (root: string, files: string[]) => markSeries(files.map((file) => parseDoc(file, redactSecrets(readFileSync(join(root, file), "utf8")).slice(0, headLimit))));

export function readLibrary(root: string, cacheFile?: string): Doc[] {
  if (!existsSync(root)) return [];
  const files = markdownFiles(root);
  if (!cacheFile) return parseAll(root, files);
  const signature = `${root}:${files.length}:${Math.max(0, ...files.map((file) => statSync(join(root, file)).mtimeMs))}`;
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (cached.signature === signature) return cached.docs;
  } catch {}
  const docs = parseAll(root, files);
  try {
    mkdirSync(join(cacheFile, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(cacheFile, JSON.stringify({ signature, docs }), { mode: 0o600 });
  } catch {}
  return docs;
}

function rarity(docs: Doc[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const doc of docs) for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return new Map([...counts].map(([term, count]) => [term, Math.log((docs.length + 1) / count)]));
}

const newestFirst = (a: Doc, b: Doc) => (b.date ?? "").localeCompare(a.date ?? "");

export function related(docs: Doc[], prompt: string, limit = 3): Doc[] {
  const said = new Set(words(prompt));
  const phrase = ` ${prompt.toLowerCase().replace(/[^a-z0-9äöüß]+/g, " ")} `;
  const weight = rarity(docs);
  return docs
    .filter((doc) => doc.status === "current")
    .flatMap((doc) => {
      const hits = doc.terms.filter((term) => said.has(term) && (weight.get(term) ?? 0) > 1.5);
      const topicHit = doc.topics.some((topic) => /[-\s]/.test(topic) && phrase.includes(` ${topic.replace(/[-\s]+/g, " ")} `));
      if (hits.length < 2 && !topicHit) return [];
      return [{ doc, score: hits.reduce((sum, term) => sum + weight.get(term)!, 0) + (topicHit ? 3 : 0) + (doc.type === "hub" ? 2 : 0) }];
    })
    .sort((a, b) => b.score - a.score || newestFirst(a.doc, b.doc))
    .slice(0, limit)
    .map(({ doc }) => doc);
}

export type Hit = { doc: Doc; score: number; line?: string };

export function search(docs: Doc[], query: string, read: (path: string) => string, options: { all?: boolean; limit?: number } = {}): Hit[] {
  const asked = [...new Set(query.toLowerCase().split(/\s+/).filter((word) => word.length >= 2))];
  if (!asked.length) return [];
  return docs
    .filter((doc) => options.all || doc.status === "current")
    .flatMap((doc) => {
      const head = `${doc.path} ${doc.title} ${doc.topics.join(" ")} ${doc.type}`.toLowerCase();
      const body = read(doc.path);
      const text = body.toLowerCase();
      let score = 0;
      for (const word of asked) {
        if (head.includes(word)) score += 3;
        else if (text.includes(word)) score += 1;
        else return [];
      }
      const line = body.replace(/^---\n[\s\S]*?\n---\n?/, "").split("\n").find((candidate) => asked.some((word) => candidate.toLowerCase().includes(word)));
      return [{ doc, score, line: line?.trim().slice(0, 160) }];
    })
    .sort((a, b) => b.score - a.score || newestFirst(a.doc, b.doc))
    .slice(0, options.limit ?? 10);
}

const typeOrder = ["hub", "planning", "decision", "meeting", "thread", "research", "brief", "idea", "note", "doc"];

export function renderCatalog(docs: Doc[], searchCommand = "fleet context search <words>"): string {
  const rank = (type: string) => typeOrder.indexOf(type) + 1 || 99;
  const types = [...new Set(docs.map((doc) => doc.type))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const line = (doc: Doc) =>
    `- [${doc.title.replaceAll("]", ")")}](${doc.path})${[doc.date, doc.topics.join(", "), doc.status === "superseded" ? "superseded" : ""].filter(Boolean).map((part) => ` · ${part}`).join("")}`;
  const ordered = (type: string) =>
    docs
      .filter((doc) => doc.type === type)
      .sort((a, b) => Number(a.status === "superseded") - Number(b.status === "superseded") || newestFirst(a, b) || a.path.localeCompare(b.path))
      .map(line);
  return [
    "# Context library catalog",
    "",
    "Generated by `fleet context catalog`. Do not edit: change a document's frontmatter instead.",
    `Search with \`${searchCommand}\`. Superseded documents are listed last in each type.`,
    ...types.flatMap((type) => ["", `## ${type}`, "", ...ordered(type)]),
    "",
  ].join("\n");
}

export type TopicReport = { topic: string; docs: Doc[]; hub?: Doc; stale: boolean };

export function topicReport(docs: Doc[]): TopicReport[] {
  const byTopic = new Map<string, Doc[]>();
  for (const doc of docs) if (doc.status === "current" && doc.type !== "hub") for (const topic of doc.topics) byTopic.set(topic, [...(byTopic.get(topic) ?? []), doc]);
  return [...byTopic]
    .filter(([, members]) => members.length >= 3)
    .map(([topic, members]) => {
      const hub = docs.find((doc) => doc.type === "hub" && doc.topics.includes(topic));
      return { topic, docs: members.sort(newestFirst), hub, stale: !hub || members.some((doc) => (doc.date ?? "") > (hub.date ?? "")) };
    })
    .sort((a, b) => b.docs.length - a.docs.length);
}
