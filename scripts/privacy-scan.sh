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

work=$(mktemp -d 2>/dev/null) || { echo "privacy: could not make a work directory; failing closed." >&2; exit 2; }
trap 'rm -rf "$work"' EXIT
mkdir "$work/blobs" "$work/leaks-in" 2>/dev/null || { echo "privacy: could not make a work directory; failing closed." >&2; exit 2; }
patterns=$work/patterns
failed=0

say() { printf 'privacy: %s\n' "$*" >&2; }
broken() { say "$*; failing closed."; exit 2; }

# Every tool's stderr goes to /dev/null: it can name paths or terms. Exit
# statuses decide, and the messages below are fixed text.
printf '%s\n' "${FLEET_PRIVACY_DENYLIST:-}" >"$work/list"
status=0
grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$work/list" >"$patterns" 2>/dev/null || status=$?
[ "$status" -le 1 ] || broken "could not read the deny-list"
[ -s "$patterns" ] || broken "FLEET_PRIVACY_DENYLIST is missing or empty"
status=0
grep -q -E -f "$patterns" </dev/null 2>/dev/null || status=$?
[ "$status" -le 1 ] || broken "the deny-list holds an invalid pattern"
command -v gitleaks >/dev/null 2>&1 || broken "gitleaks is missing"
command -v jq >/dev/null 2>&1 || broken "jq is missing"

# feed <name> <file>: hands <file> to gitleaks as overlapping windows of 9,900
# bytes, 1,900 bytes apart. Gitleaks 8.21.2 reads 10,000-byte chunks without
# overlap and skips a chunk that starts like a binary file. A window is one
# chunk that starts with a header line, so any secret up to 8,000 bytes lies
# whole in a window that gitleaks reads. Each window's name carries its byte
# offset and the number of lines before it, so findings keep their line.
window=9900
step=1900
feed() {
  size=$(wc -c <"$2" 2>/dev/null) || broken "could not stage $1 for gitleaks"
  size=$((size + 0))
  offset=0
  lines=0
  while :; do
    { printf 'fleet privacy scan\n'; tail -c +"$((offset + 1))" "$2" | head -c "$window"; } >"$work/leaks-in/$1~$offset~$lines" 2>/dev/null ||
      broken "could not stage $1 for gitleaks"
    [ $((offset + window)) -lt "$size" ] || break
    skipped=$(tail -c +"$((offset + 1))" "$2" 2>/dev/null | head -c "$step" | tr -dc '\n' | wc -c) || broken "could not stage $1 for gitleaks"
    lines=$((lines + skipped))
    offset=$((offset + step))
  done
}

# denied <file> <what>: reports each line of <file> that matches the deny-list.
denied() {
  status=0
  grep -n -a -i -E -f "$patterns" -- "$1" >"$work/hits" 2>/dev/null || status=$?
  [ "$status" -le 1 ] || broken "grep failed on $2"
  [ "$status" -eq 0 ] || return 0
  failed=1
  cut -d: -f1 "$work/hits" | while read -r line; do say "$2, line $line, matches a deny-list term."; done
}

# scan_commit <commit>: checks its metadata and paths, and stores its blobs.
scan_commit() {
  commit=$1
  short=$(git rev-parse --short "$commit" 2>/dev/null) || broken "could not read commit $commit"
  git log -1 --format='%an%n%ae%n%cn%n%ce%n%B' "$commit" >"$work/blobs/message-$commit" 2>/dev/null || broken "could not read commit $short"
  denied "$work/blobs/message-$commit" "the author, committer, or message of commit $short"
  feed "message-$commit" "$work/blobs/message-$commit"

  git diff-tree -r -m --root --no-renames --no-commit-id --name-only -z "$commit" >"$work/paths" 2>/dev/null || broken "could not list commit $short"
  tr '\0' '\n' <"$work/paths" >"$work/blobs/paths-$commit" 2>/dev/null || broken "could not list commit $short"
  feed "paths-$commit" "$work/blobs/paths-$commit"
  status=0
  count=$(grep -z -c -a -i -E -f "$patterns" "$work/paths" 2>/dev/null) || status=$?
  [ "$status" -le 1 ] || broken "could not check the paths of commit $short"
  if [ "$count" -gt 0 ]; then
    say "$count changed path(s) in commit $short match a deny-list term."
    failed=1
  fi

  git diff-tree -r -m --root --no-renames --no-commit-id "$commit" >"$work/tree" 2>/dev/null || broken "could not list commit $short"
  awk '/^:/ { print $2, $4 }' "$work/tree" >"$work/changed" 2>/dev/null || broken "could not list commit $short"
  while read -r filemode blob; do
    case "$blob" in *[!0]*) ;; *) continue ;; esac
    [ "$filemode" != 160000 ] || broken "commit $short adds a submodule, which this scan cannot read"
    [ ! -e "$work/blobs/$blob" ] || continue
    git cat-file blob "$blob" >"$work/blobs/$blob" 2>/dev/null || broken "could not read blob $blob"
    denied "$work/blobs/$blob" "blob $blob in commit $short"
    feed "$blob" "$work/blobs/$blob"
  done <"$work/changed"
}

case "$mode" in
  --text)
    cat >"$work/blobs/text" 2>/dev/null || broken "could not read stdin"
    [ -s "$work/blobs/text" ] || broken "the pull request text is empty"
    denied "$work/blobs/text" "the pull request title or body"
    feed text "$work/blobs/text"
    ;;
  *)
    range="$mode..HEAD"
    [ "$mode" != --all ] || range=HEAD
    git rev-list --reverse "$range" >"$work/commits" 2>/dev/null || broken "could not list the commits in $range"
    while read -r commit; do scan_commit "$commit"; done <"$work/commits"
    ;;
esac

status=0
GITLEAKS_CONFIG='' gitleaks dir --no-banner --redact --ignore-gitleaks-allow --log-level error \
  --report-format json --report-path "$work/leaks.json" "$work/leaks-in" >/dev/null 2>&1 || status=$?
[ -f "$work/leaks.json" ] || broken "gitleaks failed"
leaks=$(jq length "$work/leaks.json" 2>/dev/null) || broken "could not read the gitleaks report"
if [ "$leaks" -gt 0 ]; then
  # A window's line number counts its header line and starts after the lines before the window.
  jq -r '.[] | (.File | split("/") | last | split("~")) as $name
    | "privacy: gitleaks rule \(.RuleID) matched \($name[0]), line \(($name[2] | tonumber) + .StartLine - 1)."' \
    "$work/leaks.json" 2>/dev/null | sort -u >&2 || broken "could not read the gitleaks report"
  failed=1
elif [ "$status" -ne 0 ]; then
  broken "gitleaks failed"
fi

if [ "$failed" -ne 0 ] && [ "$mode" != --text ]; then
  say "Find a blob's commit and path with: git log --all --find-object=<blob> --raw"
fi
exit "$failed"
