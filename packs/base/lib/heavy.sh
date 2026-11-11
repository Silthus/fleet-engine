#!/bin/sh
set -eu
usage='Usage: fleet heavy [--unit <name> | --service <name> | --stop <name> | --holders] -- <command> [argument...]'
commands=$(CDPATH='' cd -- "$(dirname -- "$0")/../commands" && pwd -P)
self=$0
locks="${XDG_RUNTIME_DIR:-/tmp}/fleet-heavy"
report_every=${FLEET_HEAVY_REPORT_SECONDS:-120}

age() {
  if [ "$1" -lt 60 ]; then echo "${1}s"
  elif [ "$1" -lt 3600 ]; then echo "$(($1 / 60))m"
  else printf '%dh%02dm\n' $(($1 / 3600)) $(($1 % 3600 / 60)); fi
}

describe_job() {
  printf 'pid=%s\nstart=%s\nthread=%s\ndir=%s\ncommand=%s\n' "$$" "$(date +%s)" "${T3CODE_THREAD_ID:-}" "$PWD" "$(printf '%s' "$*" | tr '\n' ' ' | cut -c1-200)"
}

show_job() {
  pid='' start='' thread='' dir='' command=''
  while IFS='=' read -r key value; do
    case "$key" in pid) pid=$value ;; start) start=$value ;; thread) thread=$value ;; dir) dir=$value ;; command) command=$value ;; esac
  done < "$1"
  case "$start" in ''|*[!0-9]*) start=$(date +%s) ;; esac
  printf 'pid %s, %s, %sin %s: %s' "$pid" "$(age $(($(date +%s) - start)))" "${thread:+thread $thread, }" "$dir" "$command"
}

show_pid() {
  printf 'pid %s, %s, in %s: %s' "$1" "$(age "$(ps -o etimes= -p "$1" | tr -d ' ')")" "$(readlink "/proc/$1/cwd" || true)" "$(ps -o args= -p "$1" | cut -c1-200)"
}

queue_place() {
  ahead=0 queued=0
  for file in "$locks"/wait-*; do
    [ -f "$file" ] || continue
    name=${file##*/wait-}
    at=${name%%-*} pid=${name#*-}
    case "$at$pid" in ''|*[!0-9]*) rm -f "$file"; continue ;; esac
    if (flock -n 7) 7<"$file" 2>/dev/null; then rm -f "$file"; continue; fi
    queued=$((queued + 1))
    if [ "$at" -lt "$queued_at" ] || { [ "$at" -eq "$queued_at" ] && [ "$pid" -lt $$ ]; }; then ahead=$((ahead + 1)); fi
  done
}

lock_holders() {
  for fd in /proc/[0-9]*/fd/9; do
    [ "$(readlink "$fd" 2>/dev/null)" = "$locks/slot-$1" ] || continue
    pid=${fd#/proc/} pid=${pid%%/*}
    parent=$(ps -o ppid= -p "$pid" | tr -d ' ')
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$self" && continue
    echo "$pid $parent"
  done
}

describe_slots() {
  slot=1
  while [ "$slot" -le "$slots" ]; do
    holder="$locks/slot-$slot.holder"
    if ( flock -n 9 && rm -f "$holder" ) 9>"$locks/slot-$slot" 2>/dev/null; then
      echo "  slot $slot: free"
      slot=$((slot + 1))
      continue
    fi
    job=$(sed -n 's/^pid=//p' "$holder" 2>/dev/null || true)
    if [ -n "$job" ] && [ "$(readlink "/proc/$job/fd/9" 2>/dev/null)" = "$locks/slot-$slot" ]; then
      echo "  slot $slot: $(show_job "$holder")"
    else
      top=$(lock_holders "$slot" | awk 'NF { parent[$1] = $2; order[++n] = $1 } END { for (i = 1; i <= n; i++) if (!(parent[order[i]] in parent)) { print order[i]; exit } }')
      if [ -z "$top" ]; then
        echo "  slot $slot: held by a process that this user cannot see"
      elif [ -f "$holder" ]; then
        echo "  slot $slot: the job exited, but a process it started holds the slot: $(show_pid "$top"). The job was $(show_job "$holder")"
      else
        echo "  slot $slot: $(show_pid "$top")"
      fi
    fi
    slot=$((slot + 1))
  done
}

check_slots() {
  case "$slots" in
    ''|*[!0-9]*|0*) echo "Fleet heavy: base.heavySlots must be a whole number above 0, not '$slots'." >&2; exit 2 ;;
  esac
}

unit='' service='' stop='' holders=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --unit|--service|--stop)
      [ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }
      case "$2" in ''|-*|*[!A-Za-z0-9_.@-]*) echo "Fleet heavy: invalid unit name '$2'." >&2; exit 2 ;; esac
      case "$1" in --unit) unit=$2 ;; --service) service=$2 ;; --stop) stop=$2 ;; esac
      shift 2 ;;
    --holders) holders=1; shift ;;
    -h|--help)
      printf '%s\n\n%s\n%s\n%s\n' "$usage" 'Runs builds, broad tests, typechecks, and previews in the capped fleet-heavy.slice.' \
        'Example: fleet heavy -- bun run test' \
        'fleet heavy --holders shows the jobs that hold the slots and the jobs that wait for one.'
      exit 0 ;;
    --) shift; break ;;
    *) break ;;
  esac
done

if [ -n "$stop" ]; then
  exec systemctl --user stop "$stop"
fi
if [ -n "$holders" ]; then
  [ "$(uname -s)" = Linux ] || { echo "Fleet heavy: only Linux has slots."; exit 0; }
  [ -d "$locks" ] || { echo "Fleet heavy: no job has run here yet."; exit 0; }
  slots=${FLEET_HEAVY_SLOTS:?}
  check_slots
  echo "Fleet heavy slots on $(hostname):"
  describe_slots
  queued_at=$(date +%s)
  queue_place
  if [ "$queued" -eq 0 ]; then echo "No job waits."; else echo "Waiting, oldest first:"; fi
  for file in "$locks"/wait-*; do
    [ ! -f "$file" ] || printf '%s\n' "${file##*/wait-}"
  done | sort -t- -k1,1n -k2,2n | while read -r name; do
    echo "  $(show_job "$locks/wait-$name")"
  done
  exit 0
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
    --setenv=PATH="$PATH" ${HOME:+--setenv=HOME="$HOME"} ${FLEET_PROFILE_DIR:+--setenv=FLEET_PROFILE_DIR="$FLEET_PROFILE_DIR"} \
    ${FLEET_MEMORY_DIR:+--setenv=FLEET_MEMORY_DIR="$FLEET_MEMORY_DIR"} ${XDG_STATE_HOME:+--setenv=XDG_STATE_HOME="$XDG_STATE_HOME"} \
    ${XDG_CONFIG_HOME:+--setenv=XDG_CONFIG_HOME="$XDG_CONFIG_HOME"} \
    ${VSCODE_PROXY_URI:+--setenv=VSCODE_PROXY_URI="$VSCODE_PROXY_URI"} -- "$@"
  echo "Fleet heavy: $service serves from $(hostname)."
  exit 0
fi

slots=${FLEET_HEAVY_SLOTS:?}
check_slots
mkdir -p "$locks"

run_in_slot() {
  exec 9>"$locks/slot-$1"
  flock -n 9 || { exec 9>&-; return 1; }
  slot=$1 holder="$locks/slot-$1.holder"
  shift
  describe_job "$@" > "$holder.$$" && mv -f "$holder.$$" "$holder"
  disk_has_room
  rm -f "$waiting"
  exec 8>&-
  trap - EXIT INT TERM
  echo "Fleet heavy: runs in slot $slot after $(age $(($(date +%s) - queued_at))) in the queue." >&2
  exec systemd-run --user --scope --quiet --collect ${unit:+--unit="$unit"} --slice=fleet-heavy.slice -- "$@"
}

queued_at=$(date +%s)
waiting="$locks/wait-$queued_at-$$"
exec 8>"$locks/new-$queued_at-$$"
flock -n 8
describe_job "$@" >&8
mv "$locks/new-$queued_at-$$" "$waiting"
trap 'rm -f "$waiting"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
reported=0
while :; do
  queue_place
  if [ "$ahead" -eq 0 ]; then
    slot=1
    while [ "$slot" -le "$slots" ]; do
      run_in_slot "$slot" "$@" || true
      slot=$((slot + 1))
    done
  fi
  now=$(date +%s)
  if [ $((now - reported)) -ge "$report_every" ]; then
    echo "Fleet heavy: waiting for one of $slots slots; this job is number $((ahead + 1)) of $queued in the queue and waited $(age $((now - queued_at))) so far. The slots:" >&2
    describe_slots >&2
    echo "Fleet heavy reports again every $(age "$report_every"). Your own timeout keeps running while this job waits." >&2
    reported=$now
  fi
  sleep 1
done
