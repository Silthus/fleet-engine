import { parse, stringify } from "smol-toml";

export type Document = Record<string, unknown>;
export type Field = { path: string[]; value: unknown; pack?: string };

export const isDocument = (value: unknown): value is Document => value !== null && typeof value === "object" && !Array.isArray(value);
export const samePath = (left: string[], right: string[]) => left.length === right.length && left.every((key, index) => key === right[index]);
export const overlaps = (left: string[], right: string[]) => left.slice(0, right.length).every((key, index) => key === right[index]) || right.slice(0, left.length).every((key, index) => key === left[index]);
const unsafe = new Set(["__proto__", "prototype", "constructor"]);

export function checkPath(path: string[], label: string) {
  if (!path.length || path.some((key) => !key || unsafe.has(key))) throw new Error(`${label} is not a usable settings key`);
  return path;
}

/** A dotted key as a path. A plugin id after enabledPlugins or plugins, or a server name after mcpServers, stays one key, dots included. */
export function keyPath(key: string) {
  const named = key.match(/^(enabledPlugins|mcpServers|plugins)\.(.+)$/);
  return checkPath(named ? [named[1]!, named[2]!] : key.split("."), key);
}

export const same = (left: unknown, right: unknown) => left === right || (left !== undefined && right !== undefined && sortedJson(left) === sortedJson(right));

export function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${sortedJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function get(document: Document, path: string[]): unknown {
  let value: unknown = document;
  for (const key of path) value = isDocument(value) && Object.hasOwn(value, key) ? value[key] : undefined;
  return value;
}

export function set(document: Document, path: string[], value: unknown) {
  let parent = document;
  for (const key of path.slice(0, -1)) {
    if (!isDocument(parent[key])) define(parent, key, {});
    parent = parent[key] as Document;
  }
  define(parent, path.at(-1)!, value);
}

export function remove(document: Document, path: string[]) {
  const [key, ...rest] = path;
  if (key === undefined || !Object.hasOwn(document, key)) return;
  const child = document[key];
  if (rest.length) {
    if (!isDocument(child)) return;
    remove(child, rest);
    if (Object.keys(child).length) return;
  }
  delete document[key];
}

function define(parent: Document, key: string, value: unknown) {
  Object.defineProperty(parent, key, { value, enumerable: true, configurable: true, writable: true });
}

export type Format = { decode(text: string): Document; encode(document: Document): string };

export const json: Format = {
  decode: (text) => expectDocument(JSON.parse(text)),
  encode: (document) => `${JSON.stringify(document, null, 2)}\n`,
};

export const toml: Format = {
  decode: (text) => expectDocument(parse(text)),
  encode: (document) => `${stringify(document)}\n`,
};

function expectDocument(value: unknown): Document {
  if (!isDocument(value)) throw new Error("expected a configuration object");
  return value;
}
