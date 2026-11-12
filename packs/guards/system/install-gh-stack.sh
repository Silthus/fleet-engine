#!/bin/sh
set -eu

tag=v0.3.0
check=false
[ "${1:-}" = "--check" ] && check=true
fail() { echo "gh-stack: $*" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "gh-stack: skipped, gh is not installed."; exit 0; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) sum=957e822cfa7e435cd84a297cd96c419b58e51e3ac58be249762c24bd9e45099b ;;
  Linux-aarch64|Linux-arm64) sum=803ec91eeba9b2ac38827e299a79830fe75ca7284f0c28d60e6a2704bb34ed13 ;;
  Darwin-arm64) sum=70c0cb11346ad5d4f97a02a5cf5242052254d1775d356dc0759f035457873850 ;;
  Darwin-x86_64) sum=edea1d5f3ec80fe6596f44d438604b05846fcbcac3fff0707dbe7071794bd6a9 ;;
  *) fail "no pinned build for $(uname -s) $(uname -m)." ;;
esac

digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

data=${GH_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/gh}
binary="$data/extensions/gh-stack/gh-stack"
marker="$HOME/.config/fleet/gh-stack.version"
current() { [ -f "$binary" ] && [ "$(digest "$binary")" = "$sum" ]; }

if $check; then current; exit; fi
if current; then
  mkdir -p "$(dirname "$marker")"
  echo "$tag" > "$marker"
  echo "gh-stack: $tag is current."
  exit 0
fi
if [ -e "$data/extensions/gh-stack" ]; then
  [ -f "$marker" ] || fail "kept the gh-stack that Fleet did not install. Run gh extension remove stack, then fleet apply, to use the pinned $tag."
  gh extension remove stack >/dev/null
fi

gh extension install github/gh-stack --pin "$tag" >/dev/null
if ! current; then
  gh extension remove stack >/dev/null 2>&1 || true
  rm -f "$marker"
  fail "checksum mismatch for $tag. Removed it."
fi
mkdir -p "$(dirname "$marker")"
echo "$tag" > "$marker"
echo "gh-stack: installed $tag."
