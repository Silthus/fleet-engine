#!/bin/sh
# Installs Fleet from this profile: runs the engine's get.sh at the engine ref
# pinned in fleet.json, then applies this profile.
set -eu
dir=$(cd "$(dirname "$0")" && pwd -P)
ref=$(tr -d '\r\n' <"$dir/fleet.json" |
  sed -n 's/.*"engine"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p' |
  sed -n 's/.*"ref"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
case "$ref" in
  "" | *[!A-Za-z0-9._/-]*) echo "Fleet: fleet.json needs an engine ref, such as v0.1.0." >&2; exit 1 ;;
esac
script=$(mktemp)
trap 'rm -f "$script"' EXIT
url="https://raw.githubusercontent.com/Silthus/fleet-engine/$ref/get.sh"
if ! curl -fsSL "$url" -o "$script"; then
  # While the engine repository is private, a signed-in gh can still fetch it.
  if ! command -v gh >/dev/null 2>&1 || ! gh api -H "Accept: application/vnd.github.raw" "repos/Silthus/fleet-engine/contents/get.sh?ref=$ref" >"$script"; then
    echo "Fleet: could not download $url." >&2
    exit 1
  fi
fi
sh "$script" --ref "$ref" --profile "$dir"
