#!/bin/sh
set -eu

fail() {
  printf 'fleet install-codex: %s\n' "$1" >&2
  exit 1
}

point() {
  [ "$(readlink "$1" 2>/dev/null || true)" != "$2" ] || return 0
  rm -f "$1.new.$$"
  { ln -s "$2" "$1.new.$$" && mv -T "$1.new.$$" "$1"; } || fail "could not point $1 at $2."
}

published() {
  [ -x "$1/bin/codex" ] && "$1/bin/codex" --version >/dev/null 2>&1
}

case "$(uname -m)" in
  x86_64|amd64) target=x86_64-unknown-linux-musl ;;
  aarch64|arm64) target=aarch64-unknown-linux-musl ;;
  *) fail "no Codex build for $(uname -m). Install Codex from https://github.com/openai/codex." ;;
esac

command -v flock >/dev/null 2>&1 || fail "needs flock to install Codex safely. Install util-linux or BusyBox, then run fleet apply."
share="$HOME/.local/share/fleet"
package="$share/codex"
releases="$package/releases"
current="$package/current"
link="$HOME/.local/bin/codex"
mkdir -p "$share" || fail "could not create $share."
exec 9>"$share/codex.lock" || fail "could not open $share/codex.lock."
flock 9 || fail "could not lock $share/codex.lock."
if [ -e "$link" ] || [ -L "$link" ]; then
  case "$(readlink "$link" || true)" in
    "$current/bin/codex"|"$package/bin/codex") ;;
    *) fail "$link exists and Fleet did not install it. Move it away, then run fleet apply." ;;
  esac
fi

work=""
trap 'rm -rf "$work"; rm -f "$current.new.$$" "$link.new.$$"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

latest=$(curl -fsSIL -o /dev/null -w '%{url_effective}' https://github.com/openai/codex/releases/latest) || fail "could not find the latest Codex release."
tag=${latest##*/}
case "$tag" in
  rust-v*) ;;
  *) fail "could not read the latest Codex release from $latest." ;;
esac

previous=$(readlink "$current" 2>/dev/null || true)
if [ ! -d "$releases/$tag" ]; then
  base="https://github.com/openai/codex/releases/download/$tag"
  asset="codex-package-$target.tar.gz"
  work=$(mktemp -d "$share/codex-new.XXXXXX")
  curl -fsSL "$base/codex-package_SHA256SUMS" -o "$work/sums" || fail "could not download the Codex checksums from $base."
  curl -fsSL "$base/$asset" -o "$work/$asset" || fail "could not download $base/$asset."
  want=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$work/sums")
  [ -n "$want" ] || fail "the Codex $tag checksums do not list $asset."
  [ "$(sha256sum "$work/$asset" | awk '{ print $1 }')" = "$want" ] || fail "$asset does not match its checksum."
  mkdir "$work/package"
  tar -xzf "$work/$asset" -C "$work/package" || fail "could not unpack $asset."
  "$work/package/bin/codex" --version >/dev/null || fail "the downloaded Codex does not run on this machine."
  mkdir -p "$releases"
  mv -T "$work/package" "$releases/$tag" 2>/dev/null || published "$releases/$tag" || fail "could not move Codex $tag into $releases."
fi

mkdir -p "$(dirname "$link")"
point "$current" "releases/$tag"
point "$link" "$current/bin/codex"
if [ -n "$previous" ] && [ "$previous" != "releases/$tag" ]; then
  running=$(ls -l /proc/[0-9]*/exe 2>/dev/null || true)
  for entry in "$package"/* "$releases"/*; do
    case "$entry" in
      "$releases"|"$current"|"$package/$previous"|"$releases/$tag") continue ;;
    esac
    resolved=$(cd "$entry" 2>/dev/null && pwd -P) || resolved=$entry
    case "$running" in
      *" -> $resolved/"*) ;;
      *) rm -rf "$entry" ;;
    esac
  done
fi

if [ "$(command -v codex || true)" = "$HOME/.bun/bin/codex" ] && command -v bun >/dev/null 2>&1; then
  bun remove -g @openai/codex >/dev/null 2>&1 || fail "$HOME/.bun/bin/codex comes before $link on PATH. Run bun remove -g @openai/codex."
fi
"$link" --version
