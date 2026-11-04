#!/bin/sh
# Scans for secrets and deny-listed private terms.
#
#   privacy-scan.sh <base-commit>   every commit in <base>..HEAD
#   privacy-scan.sh --all           every commit that HEAD reaches, root included
#   privacy-scan.sh --text          the text on stdin, such as a PR title and body
#
# For each commit it scans the author, the committer, the message, every
# changed path, and every blob the commit adds or changes, merge results and
# blobs that a later commit deletes included. Blobs are read from Git, so
# binary files and symlink targets are scanned too.
#
# The deny-list comes from FLEET_PRIVACY_DENYLIST: one extended regex per line,
# matched case-insensitively. Lines starting with # are comments. The scan
# fails closed when the list is missing or invalid, or when a tool fails. It
# never prints a matched term, a path, or scanner output: findings name only
# commits, blob ids, line numbers, and gitleaks rule ids.
set -eu

mode=${1:?usage: privacy-scan.sh <base-commit> | --all | --text}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/blobs"
patterns=$work/patterns
failed=0

say() { printf 'privacy: %s\n' "$*" >&2; }
broken() { say "$*; failing closed."; exit 2; }

printf '%s\n' "${FLEET_PRIVACY_DENYLIST:-}" | { grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' || true; } >"$patterns"
[ -s "$patterns" ] || broken "FLEET_PRIVACY_DENYLIST is missing or empty"
status=0
grep -q -E -f "$patterns" </dev/null || status=$?
[ "$status" -le 1 ] || broken "the deny-list holds an invalid pattern"
command -v gitleaks >/dev/null 2>&1 || broken "gitleaks is missing"
command -v jq >/dev/null 2>&1 || broken "jq is missing"

# denied <file> <what>: reports each line of <file> that matches the deny-list.
denied() {
  status=0
  grep -n -a -i -E -f "$patterns" -- "$1" >"$work/hits" || status=$?
  [ "$status" -le 1 ] || broken "grep failed on $2"
  [ "$status" -eq 0 ] || return 0
  failed=1
  cut -d: -f1 "$work/hits" | while read -r line; do say "$2, line $line, matches a deny-list term."; done
}

# scan_commit <commit>: checks its metadata and paths, and stores its blobs.
scan_commit() {
  commit=$1
  short=$(git rev-parse --short "$commit")
  git log -1 --format='%an%n%ae%n%cn%n%ce%n%B' "$commit" >"$work/blobs/message-$commit"
  denied "$work/blobs/message-$commit" "the author, committer, or message of commit $short"

  git diff-tree -r -m --root --no-renames --no-commit-id --name-only -z "$commit" >"$work/paths" || broken "could not list commit $short"
  status=0
  count=$(grep -z -c -a -i -E -f "$patterns" "$work/paths") || status=$?
  [ "$status" -le 1 ] || broken "could not check the paths of commit $short"
  if [ "$count" -gt 0 ]; then
    say "$count changed path(s) in commit $short match a deny-list term."
    failed=1
  fi

  git diff-tree -r -m --root --no-renames --no-commit-id "$commit" >"$work/tree" || broken "could not list commit $short"
  awk '/^:/ { print $2, $4 }' "$work/tree" >"$work/changed"
  while read -r filemode blob; do
    case "$blob" in *[!0]*) ;; *) continue ;; esac
    [ "$filemode" != 160000 ] || broken "commit $short adds a submodule, which this scan cannot read"
    [ ! -e "$work/blobs/$blob" ] || continue
    git cat-file blob "$blob" >"$work/blobs/$blob" || broken "could not read blob $blob"
    denied "$work/blobs/$blob" "blob $blob in commit $short"
  done <"$work/changed"
}

case "$mode" in
  --text)
    cat >"$work/blobs/text"
    denied "$work/blobs/text" "the pull request title or body"
    ;;
  *)
    range="$mode..HEAD"
    [ "$mode" != --all ] || range=HEAD
    git rev-list --reverse "$range" >"$work/commits" || broken "could not list the commits in $range"
    while read -r commit; do scan_commit "$commit"; done <"$work/commits"
    ;;
esac

status=0
GITLEAKS_CONFIG='' gitleaks dir --no-banner --redact --ignore-gitleaks-allow --log-level error \
  --report-format json --report-path "$work/leaks.json" "$work/blobs" >/dev/null 2>&1 || status=$?
[ -f "$work/leaks.json" ] || broken "gitleaks failed"
leaks=$(jq length "$work/leaks.json") || broken "could not read the gitleaks report"
if [ "$leaks" -gt 0 ]; then
  jq -r '.[] | "privacy: gitleaks rule \(.RuleID) matched \(.File | split("/") | last), line \(.StartLine)."' "$work/leaks.json" >&2
  failed=1
elif [ "$status" -ne 0 ]; then
  broken "gitleaks failed"
fi

if [ "$failed" -ne 0 ] && [ "$mode" != --text ]; then
  say "Find a blob's commit and path with: git log --all --find-object=<blob> --raw"
fi
exit "$failed"
