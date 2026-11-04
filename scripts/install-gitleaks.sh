#!/bin/sh
# Installs the pinned gitleaks release for linux x64 into $1 after a checksum check.
set -eu
version=8.21.2
sha256=5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba
dir=${1:?usage: install-gitleaks.sh <bin-dir>}
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
curl -fsSL -o "$archive" "https://github.com/gitleaks/gitleaks/releases/download/v$version/gitleaks_${version}_linux_x64.tar.gz"
echo "$sha256  $archive" | sha256sum -c - >/dev/null
mkdir -p "$dir"
tar -xzf "$archive" -C "$dir" gitleaks
