#!/bin/sh
set -eu
config=${FLEET_SYSTEM_ROOT:-}/etc/default/earlyoom
marker="# Managed by Fleet's Guards pack. Delete this line to keep your own settings."
prefer='^(node|MainThread|python3?|pytest|esbuild|chrome.*|jest|vitest|tsc|tsgo|turbo)$'
avoid='^(t3|node-MainThread|claude|codex|agentapi|sshd|dockerd|containerd.*|postgres|redis-server|tmux|systemd.*)$'
desired=$(printf '%s\nEARLYOOM_ARGS="-m 10,7 -s 100,100 --prefer %s --avoid %s"' "$marker" "$prefer" "$avoid")

installed() { dpkg-query -W -f='${Status}' earlyoom 2>/dev/null | grep -q 'install ok installed'; }
package_default() { dpkg-query -W -f='${Conffiles}\n' earlyoom 2>/dev/null | awk '$1 == "/etc/default/earlyoom" { print $2 }'; }
own_config() { [ -e "$config" ] && [ "$(head -n 1 "$config")" != "$marker" ] && [ "$(md5sum < "$config" | cut -d' ' -f1)" != "$(package_default)" ]; }

if [ "${1:-}" = --check ]; then
  { own_config || [ "$(cat "$config" 2>/dev/null)" = "$desired" ]; } && systemctl is-active --quiet earlyoom
  exit
fi
if ! installed; then
  command -v apt-get >/dev/null 2>&1 || { echo "earlyoom: install it with your package manager, then run this again." >&2; exit 1; }
  apt-get install -y earlyoom
fi
if own_config; then
  echo "earlyoom: kept your own $config, because its first line is not Fleet's marker."
  systemctl enable --now earlyoom
elif [ "$(cat "$config" 2>/dev/null)" != "$desired" ]; then
  mkdir -p "${config%/*}"
  printf '%s\n' "$desired" > "$config"
  systemctl enable earlyoom
  systemctl restart earlyoom
else
  systemctl enable --now earlyoom
fi
systemctl is-active --quiet earlyoom || { echo "earlyoom: it is not running. Check journalctl -u earlyoom." >&2; exit 1; }
echo "earlyoom: on. It stops a test or build at 10% free memory, before T3 or the agents."
