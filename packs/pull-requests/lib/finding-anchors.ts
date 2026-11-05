export type EarlierFindings = { label: string; findings: string };

type Finding = { text: string; file: string; lines: [number, number]; anchor: string };
type Side = Map<number, string>;
type FileLines = { added: Side; removed: Side };

export const anchorHeading = "## Anchor check";

const anchorMarker = /\|\s*anchor:\s*/;
const location = /([^\s|`(]+):(\d+)(?:-(\d+))?/g;
const hasLocation = /[^\s|`(]+:\d+/;
const shortestQuote = 10;

export function anchorCheck(findings: string, diff: string, earlier: EarlierFindings[]) {
  const lines = diffLines(diff);
  const anchored = anchoredFindings(findings, lines);
  const unanchored = findingLines(findings).length - anchored.length;
  const missing = anchored.filter((finding) => !inDiff(finding, lines));
  const repeats = anchored.flatMap((finding) => {
    const seen = earlier.filter((review) => anchoredFindings(review.findings, lines).some((before) => sameFinding(before, finding)));
    return seen.length ? [`- Seen before in ${seen.map((review) => review.label).join(", ")}: ${finding.file}: \`${finding.anchor}\``] : [];
  });
  const notes = [
    ...missing.map((finding) => `- Not in the diff, so check it before triage: ${finding.text}`),
    ...unanchored > 0 ? [`- ${unanchored} finding${unanchored === 1 ? "" : "s"} quote${unanchored === 1 ? "s" : ""} no anchor.`] : [],
    ...repeats,
  ];
  return notes.length ? `${anchorHeading}\n\nfleet compared each finding's anchor with the diff and with earlier reviews of this PR.\n\n${notes.join("\n")}` : "";
}

function findingLines(findings: string) {
  return findings.split("\n").map((line) => line.trim()).filter((line) => /^(?:[-*]|\d+\.)\s+\S/.test(line) && hasLocation.test(line));
}

function anchoredFindings(findings: string, lines: Map<string, FileLines>): Finding[] {
  return findingLines(findings).flatMap((text) => {
    const marker = anchorMarker.exec(text);
    if (!marker) return [];
    const anchor = normalized(text.slice(marker.index + marker[0].length));
    const locations = [...text.slice(0, marker.index).matchAll(location)];
    const found = locations.find((match) => lines.has(match[1]!)) ?? locations[0];
    if (!anchor || !found) return [];
    const first = Number(found[2]);
    return [{ text, file: found[1]!, lines: [first, Math.max(first, Number(found[3] ?? first))], anchor }];
  });
}

function diffLines(diff: string) {
  const files = new Map<string, FileLines>();
  let current: FileLines | undefined;
  let oldPath: string | undefined;
  let [oldLine, newLine] = [0, 0];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { current = undefined; oldPath = undefined; continue; }
    if (!current && line.startsWith("--- ")) { oldPath = /^--- a\/(.+)$/.exec(line)?.[1]; continue; }
    if (!current && line.startsWith("+++ ")) {
      const path = /^\+\+\+ b\/(.+)$/.exec(line)?.[1] ?? oldPath;
      if (path) files.set(path, current = { added: new Map(), removed: new Map() });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { [oldLine, newLine] = [Number(hunk[1]), Number(hunk[2])]; continue; }
    if (!current) continue;
    const text = normalized(line.slice(1));
    if (line.startsWith("+")) current.added.set(newLine++, text);
    else if (line.startsWith("-")) current.removed.set(oldLine++, text);
    else if (line.startsWith(" ")) { current.added.set(newLine++, text); current.removed.set(oldLine++, text); }
  }
  return files;
}

function inDiff({ file, lines: [first, last], anchor }: Finding, lines: Map<string, FileLines>) {
  const changed = lines.get(file);
  if (!changed || !Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return false;
  const quoted = (text: string | undefined) => text !== undefined && (text === anchor || (anchor.length >= shortestQuote && text.includes(anchor)));
  const inRange = ([line, text]: [number, string]) => line >= first && line <= last && quoted(text);
  return [...changed.added, ...changed.removed].some(inRange);
}

function sameFinding(left: Finding, right: Finding) {
  return left.file === right.file && left.anchor === right.anchor;
}

function normalized(text: string) {
  return text.trim().replace(/^`+|`+$/g, "").trim().replace(/\s+/g, " ");
}
