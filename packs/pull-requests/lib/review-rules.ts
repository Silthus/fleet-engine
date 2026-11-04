import { basename, dirname, posix } from "node:path";

type Run = (command: string[]) => { code: number; stdout: string };

export const reviewRulesFile = "REVIEW.md";

export function reviewRules(changedFiles: string[], base: string, run: Run) {
  const rules = directoriesAbove(changedFiles)
    .map((directory) => posix.join(directory, reviewRulesFile))
    .map((path) => ({ path, rules: run(["git", "show", `${base}:${path}`]) }))
    .filter(({ rules }) => rules.code === 0 && rules.stdout.trim())
    .map(({ path, rules }) => `### ${path}\n\n${rules.stdout.trim()}`);
  return [...rules, ...changedRules(changedFiles)].join("\n\n");
}

function changedRules(changedFiles: string[]) {
  const changed = changedFiles.filter((file) => basename(file) === reviewRulesFile);
  return changed.length
    ? [`This PR changes ${changed.join(", ")}. The rules above come from the base branch. Review that change as a change to the reviewers' rules: name every rule it drops or weakens as a finding.`]
    : [];
}

function directoriesAbove(files: string[]) {
  const directories = new Set<string>();
  for (const file of files) {
    for (let directory = dirname(file); !directories.has(directory); directory = dirname(directory)) {
      directories.add(directory);
      if (directory === ".") break;
    }
  }
  return [...directories].sort((left, right) => depth(left) - depth(right) || left.localeCompare(right));
}

function depth(directory: string) {
  return directory === "." ? 0 : directory.split("/").length;
}
