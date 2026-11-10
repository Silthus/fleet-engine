#!/bin/sh
# Installs the pinned gitleaks release for this machine into $1 after a checksum check.
# Supports Linux and macOS on x64 and arm64.
set -eu
version=8.21.2
dir=${1:?usage: install-gitleaks.sh <bin-dir>}

os=$(uname -s)
machine=$(uname -m)
case "$os/$machine" in
  Linux/x86_64 | Linux/amd64) platform=linux_x64 sha256=5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba ;;
  Linux/aarch64 | Linux/arm64) platform=linux_arm64 sha256=654c935542c89f565aabe7bf7c6c500830f116c114f0aeb509d2460c1ac2e6da ;;
  Darwin/x86_64) platform=darwin_x64 sha256=5b42c6e4b1fd693eaeb2b5b7faa5f17a1434299d4deb2de63d4b2efd7c753128 ;;
  Darwin/arm64) platform=darwin_arm64 sha256=cad3de5dc9a4d5447d967a70a4d49499c557f04db028274cc324f9ff983f6502 ;;
  *) echo "install-gitleaks: no pinned gitleaks build for $os $machine." >&2; exit 1 ;;
esac

asset=gitleaks_${version}_$platform.tar.gz
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
curl -fsSL -o "$archive" "https://github.com/gitleaks/gitleaks/releases/download/v$version/$asset"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive")
else
  actual=$(shasum -a 256 "$archive")
fi
[ "${actual%% *}" = "$sha256" ] || { echo "install-gitleaks: checksum mismatch for $asset." >&2; exit 1; }

mkdir -p "$dir"
tar -xzf "$archive" -C "$dir" gitleaks
