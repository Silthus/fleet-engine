#!/bin/sh
set -eu

fail() {
  printf 'fleet install-codex: %s\n' "$1" >&2
  exit 1
}

case "$(uname -m)" in
  x86_64|amd64) target=x86_64-unknown-linux-musl ;;
  aarch64|arm64) target=aarch64-unknown-linux-musl ;;
  *) fail "no Codex build for $(uname -m). Install Codex from https://github.com/openai/codex." ;;
esac

share="$HOME/.local/share/fleet"
package="$share/codex"
link="$HOME/.local/bin/codex"
if [ -e "$link" ] || [ -L "$link" ]; then
  case "$(readlink "$link" || true)" in
    "$package"/*) ;;
    *) fail "$link exists and Fleet did not install it. Move it away, then run fleet apply." ;;
  esac
fi

latest=$(curl -fsSIL -o /dev/null -w '%{url_effective}' https://github.com/openai/codex/releases/latest) || fail "could not find the latest Codex release."
tag=${latest##*/}
case "$tag" in
  rust-v*) ;;
  *) fail "could not read the latest Codex release from $latest." ;;
esac
base="https://github.com/openai/codex/releases/download/$tag"
asset="codex-package-$target.tar.gz"

mkdir -p "$share" "$(dirname "$link")"
work=$(mktemp -d "$share/codex-new.XXXXXX")
trap 'rm -rf "$work"' EXIT
curl -fsSL "$base/codex-package_SHA256SUMS" -o "$work/sums" || fail "could not download the Codex checksums from $base."
curl -fsSL "$base/$asset" -o "$work/$asset" || fail "could not download $base/$asset."
want=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$work/sums")
[ -n "$want" ] || fail "the Codex $tag checksums do not list $asset."
[ "$(sha256sum "$work/$asset" | awk '{ print $1 }')" = "$want" ] || fail "$asset does not match its checksum."
mkdir "$work/package"
tar -xzf "$work/$asset" -C "$work/package" || fail "could not unpack $asset."
"$work/package/bin/codex" --version >/dev/null || fail "the downloaded Codex does not run on this machine."

rm -rf "$package"
mv "$work/package" "$package"
ln -sfn "$package/bin/codex" "$link"

if [ "$(command -v codex || true)" = "$HOME/.bun/bin/codex" ] && command -v bun >/dev/null 2>&1; then
  bun remove -g @openai/codex >/dev/null 2>&1 || fail "$HOME/.bun/bin/codex comes before $link on PATH. Run bun remove -g @openai/codex."
fi
"$link" --version
