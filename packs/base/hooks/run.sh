#!/bin/sh
# Runs every hook that a pack put in ~/.config/fleet/hooks/<event>/.
# Usage: run.sh claude|codex <event>
# It starts from the hooks directory, so a repository's bunfig.toml never loads.
set -eu
hooks="$HOME/.config/fleet/hooks"
for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  [ -x "$candidate" ] && bun_binary=$candidate && break
done
bun_binary=${bun_binary:-$(command -v bun)}
cd "$hooks"
exec "$bun_binary" "$hooks/run.ts" "$@"
