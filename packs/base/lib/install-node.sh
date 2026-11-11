#!/bin/sh
set -eu

fail() {
  printf 'fleet install-node: %s\n' "$1" >&2
  exit 1
}

PATH="$HOME/.local/bin:$PATH"
if node --version >/dev/null 2>&1 && npx --version >/dev/null 2>&1; then exit 0; fi

release="$(dirname "$0")/node.release"
pin() {
  sed -n "s/^$1 //p" "$release"
}

case "$(uname -m)" in
  x86_64|amd64) target=linux-x64 ;;
  aarch64|arm64) target=linux-arm64 ;;
  *) fail "no pinned Node.js build for $(uname -m). Install Node.js from https://nodejs.org." ;;
esac
version=$(pin version)
sum=$(pin "$target")
{ [ -n "$version" ] && [ -n "$sum" ]; } || fail "could not read the pinned Node.js release from $release."
for tool in curl sha256sum tar; do
  command -v "$tool" >/dev/null 2>&1 || fail "needs $tool to install Node.js."
done

name="node-v$version-$target"
share="$HOME/.local/share/fleet/node"
mkdir -p "$HOME/.local/share/fleet" "$HOME/.local/bin" || fail "could not create $HOME/.local/share/fleet."
work=$(mktemp -d "$HOME/.local/share/fleet/node-new.XXXXXX")
trap 'rm -rf "$work"; rm -f "$HOME/.local/bin/"*.new.$$' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -d "$share/$name" ]; then
  curl -fsSL "https://nodejs.org/dist/v$version/$name.tar.gz" -o "$work/$name.tar.gz" || fail "could not download Node.js $version."
  echo "$sum  $work/$name.tar.gz" | sha256sum -c --status - || fail "the Node.js $version download does not match its pinned checksum."
  tar -xzf "$work/$name.tar.gz" -C "$work" || fail "could not unpack Node.js $version."
  { mkdir -p "$share" && mv "$work/$name" "$share/$name"; } || fail "could not move Node.js into $share."
fi

point() {
  case "$(readlink "$1" 2>/dev/null || true)" in
    "$share"/*) ;;
    *) { [ -e "$1" ] || [ -L "$1" ]; } && return 0 ;;
  esac
  rm -f "$1.new.$$"
  { ln -s "$2" "$1.new.$$" && mv -T "$1.new.$$" "$1"; } || fail "could not link $1."
}

for tool in node npm npx; do
  point "$HOME/.local/bin/$tool" "$share/$name/bin/$tool"
done
for tool in node npx; do
  "$HOME/.local/bin/$tool" --version >/dev/null 2>&1 || fail "$HOME/.local/bin/$tool does not run. If Fleet did not put it there, fix it or move it away, then run fleet apply."
done
echo "Node.js: $version in $share/$name."
