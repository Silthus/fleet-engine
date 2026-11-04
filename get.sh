#!/bin/sh
# Fleet bootstrap. Installs what Fleet needs, fetches the engine at a pinned
# ref, then runs fleet setup, or fleet apply when --profile names a profile.
#
#   curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/get.sh | sh
#   sh get.sh [--ref <ref>] [--profile <dir> | --install-only] [-- <flags for fleet>]
#
# Running it again picks up where it stopped: every step skips what is done.
set -eu

engine_repo=${FLEET_ENGINE_REPO:-https://github.com/Silthus/fleet-engine.git}
engine_dir=${FLEET_ENGINE_DIR:-$HOME/.local/share/fleet/engine}
ref=${FLEET_ENGINE_REF:-main}
profile=
install_only=
bun_version=1.4.2

say() { printf 'Fleet: %s\n' "$*" >&2; }
fail() { say "$*"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || fail "--ref needs a value."; ref=$2; shift 2 ;;
    --profile) [ $# -ge 2 ] || fail "--profile needs a directory."; profile=$2; shift 2 ;;
    --install-only) install_only=1; shift ;;
    --) shift; break ;;
    *) fail "unknown option $1. Put flags for fleet after --." ;;
  esac
done

[ "$(id -u)" -ne 0 ] || fail "run this as your login user, without sudo."
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

download() {
  file=$(mktemp)
  curl -fsSL "$1" -o "$file" || fail "could not download $1."
  printf '%s\n' "$file"
}

mac_tools() {
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  if ! xcode-select -p >/dev/null 2>&1; then
    say "Installing the Command Line Tools. Finish the window that opens; this script waits."
    xcode-select --install >/dev/null 2>&1 || true
    until xcode-select -p >/dev/null 2>&1; do sleep 5; done
  fi
  if ! has brew; then
    say "Installing Homebrew. It asks for your Mac password once."
    installer=$(download https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)
    # Under curl | sh, stdin is the script, so Homebrew could not ask for the password.
    if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
      /bin/bash "$installer" </dev/tty || fail "Homebrew did not install."
    else
      /bin/bash "$installer" || fail "Homebrew did not install."
    fi
    has brew || fail "Homebrew installed, but brew is not on PATH."
  fi
  has gh || brew install gh
  has bun || brew install bun
  [ -d "/Applications/T3 Code.app" ] || brew install --cask t3-code
}

linux_gh() {
  case "$(uname -m)" in
    aarch64|arm64) arch=arm64 ;;
    x86_64|amd64) arch=amd64 ;;
    *) fail "no gh build for $(uname -m). Install gh from https://cli.github.com." ;;
  esac
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest) || fail "could not find the latest gh release."
  version=${latest##*/v}
  name="gh_${version}_linux_${arch}"
  work=$(mktemp -d)
  curl -fsSL "https://github.com/cli/cli/releases/download/v$version/$name.tar.gz" -o "$work/gh.tar.gz" || fail "could not download gh."
  curl -fsSL "https://github.com/cli/cli/releases/download/v$version/gh_${version}_checksums.txt" -o "$work/sums" || fail "could not download gh checksums."
  (cd "$work" && grep " $name.tar.gz\$" sums | sed "s/$name.tar.gz/gh.tar.gz/" | sha256sum -c --status -) || fail "gh checksum mismatch."
  tar -xzf "$work/gh.tar.gz" -C "$work"
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$work/$name/bin/gh" "$HOME/.local/bin/gh"
  rm -rf "$work"
}

linux_bun() {
  case "$(uname -m)" in
    aarch64|arm64) target=linux-aarch64; sum=54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7 ;;
    x86_64|amd64) target=linux-x64; sum=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913 ;;
    *) fail "no Bun build for $(uname -m). Install Bun from https://bun.sh." ;;
  esac
  work=$(mktemp -d)
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/bun-$target.zip" -o "$work/bun.zip" || fail "could not download Bun."
  echo "$sum  $work/bun.zip" | sha256sum -c --status - || fail "Bun checksum mismatch."
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$work/bun.zip" "$work"
  mkdir -p "$HOME/.bun/bin"
  install -m 755 "$work/bun-$target/bun" "$HOME/.bun/bin/bun"
  rm -rf "$work"
}

t3_cli() {
  has t3 && return 0
  installer=$(download https://t3.codes/install.sh)
  T3CODE_CHANNEL=nightly sh "$installer" || fail "T3 Code did not install."
}

fetch_engine() {
  if [ -d "$engine_dir" ] && [ ! -d "$engine_dir/.git" ] && [ -n "$(ls -A "$engine_dir")" ]; then
    fail "$engine_dir holds files that are not a Fleet engine. Move them away, or set FLEET_ENGINE_DIR."
  fi
  mkdir -p "$engine_dir"
  [ -d "$engine_dir/.git" ] || git -C "$engine_dir" init -q
  [ -z "$(git -C "$engine_dir" status --porcelain)" ] || fail "$engine_dir has local changes. Save them elsewhere and remove them, then run this again."
  if ! origin=$(git -C "$engine_dir" remote get-url origin 2>/dev/null); then
    git -C "$engine_dir" remote add origin "$engine_repo"
  elif [ "$origin" != "$engine_repo" ]; then
    say "The engine now comes from $engine_repo instead of $origin."
    git -C "$engine_dir" remote set-url origin "$engine_repo"
  fi
  git -C "$engine_dir" fetch -q --depth 1 --tags origin "$ref" || fail "could not fetch the engine at $ref from $engine_repo."
  git -C "$engine_dir" checkout -q --force --detach FETCH_HEAD
}

case "$(uname -s)" in
  Darwin) mac_tools ;;
  Linux)
    for tool in curl git tar sha256sum python3; do has "$tool" || fail "install $tool first."; done
    has gh || linux_gh
    has bun || linux_bun ;;
  *) fail "Fleet runs on macOS and Linux." ;;
esac
t3_cli
has git || fail "git is missing."
fetch_engine
say "Engine ready at $ref in $engine_dir."

[ -z "$install_only" ] || exit 0

if [ -n "$profile" ]; then
  exec sh "$engine_dir/fleet" apply --profile "$profile" "$@"
fi
if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
  exec sh "$engine_dir/fleet" setup "$@" </dev/tty
fi
exec sh "$engine_dir/fleet" setup "$@"
