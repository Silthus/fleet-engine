#!/bin/sh
set -eu
usage='Usage: fleet heavy [--unit <name> | --service <name> | --stop <name>] -- <command> [argument...]'
commands=$(CDPATH='' cd -- "$(dirname -- "$0")/../commands" && pwd -P)

unit='' service='' stop=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --unit|--service|--stop)
      [ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }
      case "$2" in ''|-*|*[!A-Za-z0-9_.@-]*) echo "Fleet heavy: invalid unit name '$2'." >&2; exit 2 ;; esac
      case "$1" in --unit) unit=$2 ;; --service) service=$2 ;; --stop) stop=$2 ;; esac
      shift 2 ;;
    -h|--help)
      printf '%s\n\n%s\n%s\n' "$usage" 'Runs builds, broad tests, typechecks, and previews in the capped fleet-heavy.slice.' \
        'Example: fleet heavy -- bun run test'
      exit 0 ;;
    --) shift; break ;;
    *) break ;;
  esac
done

if [ -n "$stop" ]; then
  exec systemctl --user stop "$stop"
fi
[ "$#" -gt 0 ] || { echo "$usage" >&2; exit 2; }
if [ -n "${FLEET_HEAVY_ROUTE:-}" ] && [ -z "$unit$service" ]; then
  route=$FLEET_HEAVY_ROUTE
  unset FLEET_HEAVY_ROUTE
  FLEET_HEAVY_ROUTED=1 exec bun "$route" "$@"
fi
if [ "$1" = fleet ]; then
  shift
  set -- /bin/sh "$(CDPATH='' cd -- "$commands/../../.." && pwd -P)/fleet" "$@"
fi
disk_has_room() { bun "$commands/disk.ts" >/dev/null || exit 75; }
disk_has_room
[ "$(uname -s)" = Linux ] || exec "$@"

if [ -n "$service" ]; then
  systemctl --user stop "$service" 2>/dev/null || true
  systemd-run --user --quiet --collect --unit="$service" --slice=fleet-heavy.slice --working-directory="$PWD" \
    --setenv=PATH="$PATH" ${FLEET_PROFILE_DIR:+--setenv=FLEET_PROFILE_DIR="$FLEET_PROFILE_DIR"} \
    ${VSCODE_PROXY_URI:+--setenv=VSCODE_PROXY_URI="$VSCODE_PROXY_URI"} -- "$@"
  echo "Fleet heavy: $service serves from $(hostname)."
  exit 0
fi

slots=${FLEET_HEAVY_SLOTS:?}
case "$slots" in
  ''|*[!0-9]*|0*) echo "Fleet heavy: base.heavySlots must be a whole number above 0, not '$slots'." >&2; exit 2 ;;
esac
locks="${XDG_RUNTIME_DIR:-/tmp}/fleet-heavy"
mkdir -p "$locks"

run_in_slot() {
  exec 9>"$locks/slot-$1"
  shift
  flock -n 9 || return 1
  disk_has_room
  exec systemd-run --user --scope --quiet --collect ${unit:+--unit="$unit"} --slice=fleet-heavy.slice -- "$@"
}

announced=''
while :; do
  slot=1
  while [ "$slot" -le "$slots" ]; do
    run_in_slot "$slot" "$@" || true
    slot=$((slot + 1))
  done
  [ -n "$announced" ] || echo "Fleet heavy: $slots heavy jobs run already; waiting for a free slot." >&2
  announced=1
  sleep 1
done
