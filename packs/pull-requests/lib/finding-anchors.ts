export type EarlierFindings = { label: string; findings: string };

type Finding = { text: string; file: string; anchor: string };

export const anchorHeading = "## Anchor check";

const anchorMarker = /\|\s*anchor:\s*/;
const location = /([^\s|`(]+):\d+/g;
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

function anchoredFindings(findings: string, lines: Map<string, Set<string>>): Finding[] {
  return findingLines(findings).flatMap((text) => {
    const marker = anchorMarker.exec(text);
    if (!marker) return [];
    const anchor = normalized(text.slice(marker.index + marker[0].length));
    const files = [...text.slice(0, marker.index).matchAll(location)].map((match) => match[1]!);
    const file = files.find((candidate) => lines.has(candidate)) ?? files[0];
    return anchor && file ? [{ text, file, anchor }] : [];
  });
}

function diffLines(diff: string) {
  const files = new Map<string, Set<string>>();
  let current: Set<string> | undefined;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { current = undefined; inHunk = false; continue; }
    const header = inHunk ? undefined : /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) { files.set(header[1]!, current = new Set()); continue; }
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (inHunk && current && /^[-+ ]/.test(line)) current.add(normalized(line.slice(1)));
  }
  return files;
}

function inDiff({ file, anchor }: Finding, lines: Map<string, Set<string>>) {
  const changed = lines.get(file);
  if (!changed) return false;
  if (changed.has(anchor)) return true;
  return anchor.length >= shortestQuote && [...changed].some((line) => line.includes(anchor));
}

function sameFinding(left: Finding, right: Finding) {
  return left.file === right.file && left.anchor === right.anchor;
}

function normalized(text: string) {
  return text.trim().replace(/^`+|`+$/g, "").trim().replace(/\s+/g, " ");
}
