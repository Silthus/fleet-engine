#!/bin/sh
# Keeps the memory checkout in step with the user's private memory repo on every machine.
# Each run commits this machine's changes, rebases them onto main, and pushes.
# With FLEET_MEMORY_SUBTREE, the checkout sits beside the memory folder, the memory folder links to that
# folder of the repo, and only that folder is committed and pushed.
# MEMORY.md and every INDEX.md merge by union. When two machines change the same lines of another file, this
# machine's version wins and the other goes to .conflicts/ in the memory folder.
# A conflict marker, a secret, or a change outside the subtree in any outgoing commit stops the push.
# Commits are signed when the user's Git config signs commits, so a repo that requires signatures takes them.
# A checkout of another repo than memory.repo moves aside, and this machine's unsynced notes carry over.
# Every state that stops the sync exits 1, so the job log and fleet doctor see it.
set -eu

url=${FLEET_MEMORY_URL:?FLEET_MEMORY_URL is not set}
memory=${FLEET_MEMORY_DIR:-$HOME/.agents/memory}
subtree=$(printf '%s' "${FLEET_MEMORY_SUBTREE:-}" | sed -e 's#^/*##' -e 's#/*$##')
machine=${CODER_WORKSPACE_NAME:-$(hostname -s)}
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
g() { git -c core.quotePath=false -C "$checkout" "$@"; }
fail() { echo "Memory: $*" >&2; exit 1; }
case "/${subtree:-x}/" in */../* | */./* | *//* | */-* | *[!A-Za-z0-9._/-]*) fail "memory.subtree $subtree must name a folder inside the memory repo, in letters, digits, dots, dashes and underscores." ;; esac
if [ -n "$subtree" ]; then
  checkout="$memory-repo"
  scope=$subtree
  [ -L "$memory" ] || [ ! -e "$memory/.git" ] || fail "$memory is a memory checkout, but memory.subtree is $subtree. Move that folder aside; the next sync sets up $checkout and links $memory to its $subtree folder."
else
  checkout=$memory
  scope=.
  [ ! -L "$memory" ] || fail "$memory is a link, but memory.subtree is empty. Remove the link; the next sync sets up a checkout there."
fi
conflicts="${subtree:+$subtree/}.conflicts"
lock="$checkout.sync-lock"
repo_name() { printf '%s\n' "$1" | sed -e 's#/*$##' -e 's#\.git$##' -e 's#^.*github\.com[:/]##'; }

mkdir -p "$(dirname "$checkout")"
stale() { [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null)" ]; }
reclaim() {
  mkdir "$lock.reclaim" 2>/dev/null || return 1
  removed=1
  if [ "$(cat "$lock/pid" 2>/dev/null || true)" = "$1" ] && { [ -n "$1" ] || stale "$lock"; }; then rm -rf "$lock"; removed=0; fi
  rmdir "$lock.reclaim"
  return "$removed"
}
waited=0
until mkdir "$lock" 2>/dev/null; do
  holder=$(cat "$lock/pid" 2>/dev/null || true)
  if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } || { [ -z "$holder" ] && stale "$lock"; }; then
    if reclaim "$holder"; then continue; fi
  fi
  waited=$((waited + 1))
  if [ "$waited" -gt 60 ]; then
    [ ! -d "$lock.reclaim" ] || fail "a stopped sync left $lock.reclaim behind. Remove that folder when no sync runs; until then nothing syncs."
    fail "another sync still holds $lock."
  fi
  sleep 1
done
echo $$ > "$lock/pid"
trap 'if [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$lock"; fi' EXIT

aside=
if [ -e "$checkout/.git" ]; then
  origin=$(g remote get-url origin 2>/dev/null || true)
  if [ "$(repo_name "$origin")" != "$(repo_name "$url")" ]; then
    aside="$checkout.old-$(date -u +%Y%m%dT%H%M%SZ)"
    carry="$(g rev-parse --absolute-git-dir)/fleet-carry"
    { g diff --name-only HEAD -- "$scope" 2>/dev/null || true
      g ls-files --others --exclude-standard -- "$scope"
      g diff --name-only origin/main...HEAD -- "$scope" 2>/dev/null || true
    } | sort -u > "$carry"
    mv "$checkout" "$aside"
  fi
fi
if [ ! -e "$checkout/.git" ]; then
  mkdir -p "$checkout"
  g init --quiet
  g symbolic-ref HEAD refs/heads/main
  g remote add origin "$url"
  echo "Memory: set up $checkout for $url."
fi
if [ -n "$aside" ]; then
  while IFS= read -r path; do
    [ -n "$path" ] && [ -f "$aside/$path" ] || continue
    mkdir -p "$(dirname "$checkout/$path")"
    cp -p "$aside/$path" "$checkout/$path"
  done < "$aside/.git/fleet-carry"
  echo "Memory: $checkout synced with $origin, but memory.repo is $url. Moved it to $aside and carried this machine's unsynced notes over."
fi

gitdir=$(g rev-parse --absolute-git-dir)
for index in MEMORY.md INDEX.md; do
  grep -qx "$index merge=union" "$gitdir/info/attributes" 2>/dev/null || { mkdir -p "$gitdir/info"; echo "$index merge=union" >> "$gitdir/info/attributes"; }
done

if [ -n "$subtree" ]; then
  target="$checkout/$subtree"
  mkdir -p "$target"
  if [ -L "$memory" ]; then
    [ "$(readlink "$memory")" = "$target" ] || ln -sfn "$target" "$memory"
  elif [ -d "$memory" ]; then
    [ ! -e "$memory.premove" ] || fail "$memory.premove holds notes from an earlier move, and $memory is a folder again. Move the notes of both into $target; until then nothing syncs."
    mv "$memory" "$memory.premove"
    ln -s "$target" "$memory"
    if [ ! -L "$memory" ]; then
      [ ! -L "$memory/$(basename "$target")" ] || rm -f "$memory/$(basename "$target")"
      fail "$memory is a folder again: something wrote there while the sync linked it. The earlier notes are in $memory.premove. Move the notes of both into $target; until then nothing syncs."
    fi
  elif [ -e "$memory" ]; then
    fail "$memory is a file. Move it aside; the next sync links $memory to $target."
  else
    ln -s "$target" "$memory"
  fi
  if [ -d "$memory.premove" ]; then
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    (cd "$memory.premove" && find . -type f) | while IFS= read -r path; do
      path=${path#./}
      if [ ! -e "$target/$path" ]; then
        mkdir -p "$(dirname "$target/$path")"
        cp -p "$memory.premove/$path" "$target/$path"
      elif ! cmp -s "$memory.premove/$path" "$target/$path"; then
        mkdir -p "$checkout/$conflicts"
        cp -p "$memory.premove/$path" "$checkout/$conflicts/$(printf '%s' "$path" | tr '/ ' '__').premove.$stamp.$machine.lost"
        echo "Memory: kept the version of $path that was set aside, since $target holds a newer one."
      fi
    done || fail "cannot move the notes in $memory.premove into $target. They stay there until the next sync."
    rm -rf "$memory.premove"
    echo "Memory: moved the notes in $memory into $target."
  fi
fi

marker="$gitdir/fleet-sync-rebase"
snapshot="$gitdir/fleet-sync-files.tar"
rebasing() { [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; }
if rebasing && [ -f "$marker" ]; then
  conflicted=$(g diff --name-only --diff-filter=U)
  deleted=$({ g ls-files --deleted; g diff --cached --name-only --diff-filter=D; } | sort -u)
  (cd "$checkout" && tar -cf "$snapshot" --exclude=./.git .) || fail "cannot save the files before undoing an unfinished sync. Nothing changed."
  g rebase --abort
  (cd "$checkout" && tar -xf "$snapshot") || fail "undid an unfinished sync, but cannot restore the files. They are in $snapshot."
  printf '%s\n' "$deleted" | while IFS= read -r path; do
    [ -z "$path" ] || rm -f "$checkout/$path"
  done
  marked=$(printf '%s\n' "$conflicted" | while IFS= read -r path; do
    if [ -n "$path" ] && grep -q '^\(<<<<<<<\|>>>>>>>\) ' "$checkout/$path" 2>/dev/null; then
      g checkout --quiet HEAD -- "$path" 2>/dev/null || rm -f "$checkout/$path"
      echo "$path"
    fi
  done)
  if [ -n "$marked" ]; then
    echo "Memory: undid an unfinished sync rebase. Files that still held its conflict markers went back to this machine's version; the copies from the crash are in $snapshot:"
    printf '%s\n' "$marked" | sed 's/^/  /'
  else
    rm -f "$snapshot"
    echo "Memory: undid an unfinished sync rebase and kept every file as it was."
  fi
fi
rm -f "$marker"
if rebasing || [ -f "$gitdir/MERGE_HEAD" ]; then
  fail "a rebase or merge is open in $checkout. Finish or abort it; until then nothing syncs."
fi
[ "$(g symbolic-ref --short HEAD 2>/dev/null || true)" = main ] || fail "$checkout is not on main. Switch it back to main; until then nothing syncs."
[ -z "$(g diff --name-only --diff-filter=U)" ] || fail "$checkout has unresolved conflicts. Resolve them; until then nothing syncs."
[ -z "$subtree" ] || [ -z "$(g status --porcelain --untracked-files=no -- . ":(exclude)$subtree")" ] || fail "$checkout has changes outside $subtree/. Commit them through the repo's own workflow or drop them; until then nothing syncs."

if [ -n "$(g status --porcelain --untracked-files=all -- "$scope")" ]; then
  g add -A -- "$scope"
  if g diff --cached -- "$scope" | grep -q '^+\(<<<<<<<\|>>>>>>>\) '; then
    g reset --quiet -- "$scope"
    fail "a memory file holds conflict markers. Fix it; until then nothing syncs."
  fi
  changes=$(g diff --cached --name-status -- "$scope")
  g commit --quiet --no-verify -m "memory: $machine" -m "$changes" -- "$scope"
  echo "Memory: committed on $machine:"
  printf '%s\n' "$changes" | sed 's/^/  /'
fi
[ -z "$(g status --porcelain --untracked-files=no)" ] || exit 0

rebase() {
  : > "$marker"
  if g rebase --quiet -X theirs origin/main >/dev/null 2>&1; then rm -f "$marker"; return 0; fi
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
    GIT_EDITOR=true g rebase --continue >/dev/null 2>&1 || true
  done
  if rebasing; then g rebase --abort; rm -f "$marker"; return 1; fi
  rm -f "$marker"
}

at_risk() {
  base=$1 list=$2
  : > "$list"
  [ -n "$base" ] || return 0
  g diff --no-renames --name-only "$base" HEAD -- "$scope" | sort > "$list.local"
  g diff --no-renames --name-only "$base" origin/main -- "$scope" | sort > "$list.remote"
  comm -12 "$list.local" "$list.remote" | grep -v -E '(^|/)(MEMORY|INDEX)\.md$|(^|/)\.conflicts/' > "$list" || true
  rm -f "$list.local" "$list.remote"
}

keep_lost() {
  base=$1 list=$2
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    g cat-file -e "origin/main:$path" 2>/dev/null || continue
    lost=0
    if [ ! -f "$checkout/$path" ]; then
      lost=1
    else
      g diff --no-renames -U0 "$base" origin/main -- "$path" | awk '/^@@/ { hunk = 1; next } hunk && /^\+/ { print substr($0, 2) }' > "$list.added"
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        grep -Fxq -- "$line" "$checkout/$path" || { lost=1; break; }
      done < "$list.added"
      rm -f "$list.added"
    fi
    [ "$lost" = 1 ] || continue
    mkdir -p "$checkout/$conflicts"
    id=$(printf '%s' "$path" | g hash-object --stdin | cut -c1-8)
    kept="$checkout/$conflicts/$(printf '%s' "${path#"$subtree/"}" | tr '/ ' '__').$id.$stamp.$machine.lost"
    { echo "<!-- The memory sync on $machine at $stamp replaced this version of $path. Merge what it has into that file, then delete this one. -->"; g show "origin/main:$path"; } > "$kept"
    echo "Memory: kept the other side of a conflict in $path as ${kept#"$checkout/"}."
  done < "$list"
  rm -f "$list"
  if [ -n "$(g status --porcelain --untracked-files=all -- "$conflicts")" ]; then
    g add -- "$conflicts"
    g commit --quiet --no-verify -m "memory: $machine kept a sync conflict" -- "$conflicts"
  fi
}

remote_has_main() {
  status=0
  g ls-remote --exit-code --heads origin main >/dev/null 2>&1 || status=$?
  [ "$status" -ne 0 ] || return 0
  [ "$status" -eq 2 ] || fail "cannot reach $url."
  [ -z "$(g ls-remote --heads origin)" ] || fail "$url has no main branch. Rename its default branch to main; until then nothing syncs."
  return 1
}
has_commits() { g rev-parse --quiet --verify HEAD >/dev/null; }

attempt=1
while :; do
  if remote_has_main; then
    g fetch --quiet origin main || fail "cannot fetch $url."
    if ! has_commits; then
      if g checkout --quiet --no-overwrite-ignore -B main origin/main 2>/dev/null; then
        echo "Memory: checked out $url."
      else
        echo "Memory: files appeared while setting up. The next sync merges them."
      fi
      exit 0
    fi
    parted=$(g merge-base HEAD origin/main 2>/dev/null || g hash-object -t tree /dev/null)
    at_risk "$parted" "$gitdir/fleet-sync-at-risk"
    rebase || fail "cannot rebase $checkout onto origin/main. Not synced."
    keep_lost "$parted" "$gitdir/fleet-sync-at-risk"
    base=origin/main
  else
    has_commits || { echo "Memory: $url is empty, and this machine has nothing to share yet."; exit 0; }
    base=
  fi
  range=${base:+$base..}HEAD
  [ "$(g rev-list --count "$range")" -gt 0 ] || exit 0
  if [ -n "$subtree" ]; then
    outside=$(g log --format= --name-only "$range" -- . ":(exclude)$subtree" | sort -u)
    [ -z "$outside" ] || fail "commits on this machine change files outside $subtree/: $outside. Move them to the repo's own workflow; until then nothing syncs."
  fi
  scan=0
  bun "$here/secret-scan.ts" "$checkout" "$range" || scan=$?
  if [ "$scan" -eq 1 ]; then
    if [ -n "$base" ]; then g reset --quiet "$base"; else g update-ref -d HEAD && g read-tree --empty; fi
    fail "an unpushed memory change holds a secret. The sync took its commits back and left the files as they are. Remove the secret; until then nothing syncs."
  fi
  [ "$scan" -eq 0 ] || fail "cannot scan the outgoing memory for secrets. Nothing was pushed."
  if g push --quiet "$url" HEAD:main 2>/dev/null; then
    echo "Memory: pushed from $machine."
    exit 0
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -le 3 ] || fail "push failed three times. The commits stay here for the next run."
done
