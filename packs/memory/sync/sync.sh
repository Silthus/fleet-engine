#!/bin/sh
# Keeps the memory checkout in step with the user's private memory repo on every machine.
# Each run commits this machine's changes, rebases them onto main, and pushes.
# MEMORY.md merges by union. When two machines change the same lines of another file, this machine's
# version wins and the other stays in history. A conflict marker or a secret stops the push.
# Every state that stops the sync exits 1, so the job log and fleet doctor see it.
set -eu

url=${FLEET_MEMORY_URL:?FLEET_MEMORY_URL is not set}
checkout=${FLEET_MEMORY_DIR:-$HOME/.agents/memory}
machine=${CODER_WORKSPACE_NAME:-$(hostname -s)}
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
g() { git -C "$checkout" "$@"; }
fail() { echo "Memory: $*" >&2; exit 1; }

if [ ! -e "$checkout" ]; then
  mkdir -p "$(dirname "$checkout")"
  git clone --quiet "$url" "$checkout" || fail "cannot clone $url."
  g config commit.gpgsign false
  echo "Memory: cloned into $checkout."
fi

gitdir=$(g rev-parse --absolute-git-dir)
grep -qx 'MEMORY.md merge=union' "$gitdir/info/attributes" 2>/dev/null || { mkdir -p "$gitdir/info"; echo 'MEMORY.md merge=union' >> "$gitdir/info/attributes"; }

if [ -z "${FLEET_MEMORY_LOCKED:-}" ] && command -v flock >/dev/null 2>&1; then
  FLEET_MEMORY_LOCKED=1 exec flock -w 60 "$gitdir/fleet-sync.lock" sh "$0" "$@"
fi

marker="$gitdir/fleet-sync-rebase"
rebasing() { [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; }
if rebasing && [ -f "$marker" ]; then
  g rebase --abort
  echo "Memory: undid an unfinished sync rebase."
fi
rm -f "$marker"
if rebasing || [ -f "$gitdir/MERGE_HEAD" ]; then
  fail "a rebase or merge is open in $checkout. Finish or abort it; until then nothing syncs."
fi
[ "$(g symbolic-ref --short HEAD 2>/dev/null || true)" = main ] || fail "$checkout is not on main. Switch it back to main; until then nothing syncs."
[ -z "$(g diff --name-only --diff-filter=U)" ] || fail "$checkout has unresolved conflicts. Resolve them; until then nothing syncs."

if [ -n "$(g status --porcelain --untracked-files=all)" ]; then
  g add -A
  if g diff --cached | grep -q '^+\(<<<<<<<\|>>>>>>>\) '; then
    g reset --quiet
    fail "a memory file holds conflict markers. Fix it; until then nothing syncs."
  fi
  changes=$(g diff --cached --name-status)
  g -c commit.gpgsign=false commit --quiet --no-verify -m "memory: $machine" -m "$changes"
  echo "Memory: committed on $machine:"
  printf '%s\n' "$changes" | sed 's/^/  /'
fi
[ -z "$(g status --porcelain --untracked-files=no)" ] || exit 0

rebase() {
  : > "$marker"
  if g -c commit.gpgsign=false rebase --quiet -X theirs origin/main >/dev/null 2>&1; then rm -f "$marker"; return 0; fi
  rebasing || { rm -f "$marker"; return 1; }
  rounds=0
  while rebasing; do
    rounds=$((rounds + 1))
    [ "$rounds" -le 50 ] || break
    unresolved=$(g diff --name-only --diff-filter=U)
    [ -n "$unresolved" ] || break
    printf '%s\n' "$unresolved" | while IFS= read -r path; do
      if g checkout --theirs -- "$path" 2>/dev/null; then g add -- "$path"; else g rm --quiet -- "$path"; fi
    done
    GIT_EDITOR=true g -c commit.gpgsign=false rebase --continue >/dev/null 2>&1 || true
  done
  if rebasing; then g rebase --abort; rm -f "$marker"; return 1; fi
  rm -f "$marker"
}

attempt=1
while :; do
  g fetch --quiet origin main || fail "cannot fetch $url."
  rebase || fail "cannot rebase $checkout onto origin/main. Not synced."
  [ "$(g rev-list --count origin/main..HEAD)" -gt 0 ] || exit 0
  g diff origin/main...HEAD | bun "$here/secret-scan.ts" || fail "outgoing memory holds a secret. Remove it and amend the commit; until then nothing syncs."
  if g push --quiet origin HEAD:main 2>/dev/null; then
    echo "Memory: pushed from $machine."
    exit 0
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -le 3 ] || fail "push failed three times. The commits stay here for the next run."
done
