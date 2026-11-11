#!/bin/sh
# Fresh-Linux-user proof. Creates two new Linux users on this machine: A runs
# the public one-liner the way a newcomer does, and B installs from the profile
# repo A's setup made, the way a devbox does. It checks both, prints PASS or
# FAIL per check as it goes, then removes both users. Run it as root on a
# throwaway Linux box with systemd, cron, curl, git, ss, and python3.
#
#   sudo sh proof/fresh-linux.sh
#   sudo FLEET_PROOF_ENGINE=<git repo or bundle> sh proof/fresh-linux.sh
#
# FLEET_PROOF_ENGINE serves get.sh and the engine from that copy, at its HEAD
# (or a bundle's first branch), so CI proves a pull request's tree. Without it,
# the proof uses the public repo. FLEET_PROOF_REF picks the ref (main). The
# copy's main points at the same commit, because the profile pins main.
set -eu

ref=${FLEET_PROOF_REF:-main}
source_engine=${FLEET_PROOF_ENGINE:-}
user_a=${FLEET_PROOF_USER_A:-fleetproofa}
user_b=${FLEET_PROOF_USER_B:-fleetproofb}
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
setup_flags="--non-interactive --preset everyday --plan both"
jobs="fleet-update agent-update worktree-prune"
t3_unit=t3code.service

say() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() { printf 'proof: %s\n' "$*" >&2; exit 2; }

[ "$(id -u)" -eq 0 ] || die "run this as root, with sudo."
[ "$(uname -s)" = Linux ] || die "this proof runs on Linux."
for tool in useradd userdel loginctl systemctl crontab curl git setsid sudo sha256sum ss python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is missing."
done
for tool in gh bun; do
  found=$(PATH=/usr/local/bin:/usr/bin:/bin; command -v "$tool" || true)
  [ -z "$found" ] || die "$tool is installed at $found, so the proof cannot show that get.sh installs it. Run it on a box without $tool, or move $found aside."
done
for user in "$user_a" "$user_b"; do
  ! id "$user" >/dev/null 2>&1 || die "user $user exists already. Remove it, or set FLEET_PROOF_USER_A and FLEET_PROOF_USER_B."
done

work=$(mktemp -d /var/tmp/fleet-proof.XXXXXX)
chmod 755 "$work"
github="$work/github"
fails="$work/fails"
: >"$fails"
created=
clean_uids=
cleanup_failed=

home_of() { getent passwd "$1" | cut -d: -f6; }

remove_user() {
  user=$1
  home=$2
  if ! uid=$(id -u "$user" 2>/dev/null); then
    note "$user has no account to remove"
    return
  fi
  if [ "$(home_of "$user")" != "$home" ]; then
    note "left $user alone: its home is $(home_of "$user"), not the proof's $home"
    return
  fi
  crontab -r -u "$user" 2>/dev/null
  loginctl disable-linger "$user" 2>/dev/null
  systemctl stop "user@$uid.service" 2>/dev/null
  pkill -KILL -u "$uid" 2>/dev/null
  sleep 1
  case " $clean_uids " in *" $uid "*) find /tmp /var/tmp -xdev -path "$work" -prune -o -user "$uid" -prune -exec rm -rf {} + 2>/dev/null ;; esac
  if ! userdel "$user" 2>/dev/null && id "$user" >/dev/null 2>&1; then
    note "could not remove $user (uid $uid), so its home $home stays"
    cleanup_failed=1
    return
  fi
  [ ! -f "/var/mail/$user" ] || [ "$(stat -c %u "/var/mail/$user")" != "$uid" ] || rm -f "/var/mail/$user"
  case "$home" in
    "$work"/home-*) [ -L "$home" ] || [ ! -d "$home" ] || [ "$(stat -c %u "$home")" != "$uid" ] || rm -rf "$home" ;;
  esac
  note "removed $user (uid $uid), its home $home, and its crontab"
}

cleanup() {
  code=$?
  set +e
  trap '' HUP INT TERM
  say "Cleanup"
  for entry in $created; do remove_user "${entry%%:*}" "${entry#*:}"; done
  if [ -n "$cleanup_failed" ]; then
    note "kept $work, because an account in it is still there"
    [ "$code" -ne 0 ] || code=1
  else
    rm -rf "$work"
    note "removed $work"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

pass() { printf 'PASS %s: %s\n' "$1" "$2"; }
fail() {
  printf 'FAIL %s: %s\n' "$1" "$2"
  printf '%s: %s\n' "$1" "$2" >>"$fails"
}

as_user() {
  user=$1
  shift
  uid=$(id -u "$user")
  home=$(home_of "$user")
  set -f
  sudo -u "$user" -- setsid -w env -i -C "$home" HOME="$home" USER="$user" LOGNAME="$user" SHELL=/bin/bash LANG=C.UTF-8 TERM=dumb \
    PATH="$home/.proof/bin:/usr/local/bin:/usr/bin:/bin" \
    XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
    GIT_CONFIG_SYSTEM="$work/gitconfig" \
    ${engine_url:+FLEET_ENGINE_REPO="$engine_url"} \
    "$@" </dev/null
  status=$?
  set +f
  return "$status"
}

logged() {
  log=$1
  shift
  set +e
  { "$@"; echo "$?" >"$log.code"; } 2>&1 | tee "$log" >&2
  set -e
  cat "$log.code"
}

fleet_cmd_env() {
  user=$1
  shift
  home=$(home_of "$user")
  as_user "$user" env PATH="$home/.local/bin:$home/.bun/bin:$home/.proof/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}

fleet_cmd() {
  user=$1
  shift
  fleet_cmd_env "$user" sh "$(home_of "$user")/.local/share/fleet/engine/fleet" "$@"
}

check_codex() {
  user=$1
  home=$(home_of "$user")
  path=
  for dir in "$home/.local/bin" "$home/.bun/bin" "$home/.proof/bin" /usr/local/bin /usr/bin /bin; do
    if [ -x "$dir/node" ] && [ "${dir#"$home"/}" = "$dir" ]; then
      note "hid the box's own Node at $dir/node: the check runs without $dir on PATH"
      continue
    fi
    path="${path:+$path:}$dir"
  done
  where=$(as_user "$user" env PATH="$path" /bin/sh -c 'command -v codex' || true)
  node=$(as_user "$user" env PATH="$path" /bin/sh -c 'command -v node' || true)
  note "codex: ${where:-not found}; node: ${node:-not found}"
  if [ -n "$where" ]; then
    case "$(head -c 2 "$where" 2>/dev/null)" in
      '#!') note "codex launcher: $(head -1 "$where")" ;;
      *) note "codex launcher: a binary, $(readlink -f "$where")" ;;
    esac
  fi
  if [ -n "$node" ]; then
    fail "$user codex runs" "node is on $user's PATH at $node, so this does not show that codex runs without Node"
  elif version=$(as_user "$user" env PATH="$path" codex --version 2>&1); then
    pass "$user codex runs" "codex --version, with no node on PATH: $version"
  else
    fail "$user codex runs" "codex --version failed: $(printf '%s' "$version" | tail -1)"
  fi
}

check_path() {
  user=$1
  found=$(as_user "$user" bash -lc 'command -v fleet; command -v bun' 2>/dev/null || true)
  note "a new login shell finds: ${found:-neither fleet nor bun}"
  if as_user "$user" bash -lc 'fleet --help' >/dev/null 2>&1; then pass "$user fleet on PATH" "a new login shell runs fleet"; else fail "$user fleet on PATH" "a new login shell cannot run fleet"; fi
}

make_user() {
  user=$1
  home=$2
  ! id "$user" >/dev/null 2>&1 || die "user $user exists already."
  created="$created $user:$home"
  useradd -d "$home" -m -s /bin/bash -K UMASK=022 "$user"
  if [ "$(home_of "$user")" != "$home" ] || [ -L "$home" ]; then die "useradd did not give $user the home $home."; fi
  uid=$(id -u "$user")
  [ "$(stat -c %u "$home")" = "$uid" ] || die "$home is not owned by $user."
  stale=$(find /tmp /var/tmp -xdev -path "$work" -prune -o -user "$uid" -print -quit 2>/dev/null)
  [ -z "$stale" ] || die "uid $uid, which $user got, owns $stale already. Remove the leftover files, then run the proof again."
  clean_uids="$clean_uids $uid"
  install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
  install -d -m 755 -o "$user" -g "$user" "$home/.proof" "$home/.proof/bin" "$home/.config" "$home/.config/systemd" "$home/.config/systemd/user" "$home/.config/systemd/user/$t3_unit.d"
  first="$work/$user-t3-first"
  install -d -m 700 -o "$user" -g "$user" "$first"
  printf '[Service]\nExecStartPre=-/bin/sh -c %s\n' "'[ -e $first/started ] || { touch $first/started && cp $home/.t3/userdata/settings.json $first/settings.json; }'" >"$home/.config/systemd/user/$t3_unit.d/fleet-proof.conf"
  chown "$user:$user" "$home/.config/systemd/user/$t3_unit.d/fleet-proof.conf"
  loginctl enable-linger "$user"
  tries=0
  until [ -S "/run/user/$uid/bus" ] || [ "$tries" -ge 50 ]; do sleep 0.2; tries=$((tries + 1)); done
  if [ -S "/run/user/$uid/bus" ]; then
    note "created $user (uid $uid), empty ~/.ssh, lingering on, user manager running"
  else
    note "created $user (uid $uid); its systemd user manager did not start"
  fi
}

sign_in() {
  user=$1
  home=$(home_of "$user")
  sed -e "s|__STATE__|$github|" -e "s|__ENGINE_GIT__|${engine_git:-none}|" "$here/sandbox-gh.sh" >"$work/$user-gh"
  chmod 755 "$work/$user-gh"
  as_user "$user" install -m 755 "$work/$user-gh" "$home/.proof/bin/gh"
  if as_user "$user" test -f "$home/.local/bin/gh"; then
    as_user "$user" mkdir -p "$home/.proof/real"
    as_user "$user" mv "$home/.local/bin/gh" "$home/.proof/real/gh"
    note "moved the real gh get.sh installed ($(as_user "$user" "$home/.proof/real/gh" --version | head -1)) to ~/.proof/real/gh"
  fi
  note "installed the sandbox gh at ~/.proof/bin/gh: signed in as fleet-proof"
  [ -z "$engine_git" ] || serve_local_get_sh "$user"
}

serve_local_get_sh() {
  user=$1
  home=$(home_of "$user")
  real_curl=$(PATH=/usr/local/bin:/usr/bin:/bin command -v curl)
  : >"$work/$user-get-sh-fetches"
  chmod 666 "$work/$user-get-sh-fetches"
  cat >"$work/$user-curl" <<EOF
#!/bin/sh
for arg do
  shift
  case "\$arg" in
    https://raw.githubusercontent.com/Silthus/fleet-engine/*/get.sh) echo "\$arg" >>"$work/$user-get-sh-fetches"; arg="file://$work/get.sh" ;;
  esac
  set -- "\$@" "\$arg"
done
exec "$real_curl" "\$@"
EOF
  as_user "$user" install -m 755 "$work/$user-curl" "$home/.proof/bin/curl"
  note "installed a curl at ~/.proof/bin/curl that serves Silthus/fleet-engine's raw get.sh from $work/get.sh"
}

home_files() {
  find . \( -path ./.t3 -o -path ./.cache -o -path ./.bun -o -path ./.npm -o -path ./.proof \
    -o -path ./.local/share/fleet/sources -o -path ./.local/share/fleet/engine/.git -o -path ./.local/state/fleet/logs \
    -o -path ./.local/state/fleet/jobs -o -path ./.local/state/fleet/worktree-prune.last -o -path './.local/state/fleet/worktree-sightings.json*' \
    -o -path ./.local/share/claude -o -path ./.local/share/t3code -o -path ./.claude/statsig -o -path ./.claude/todos -o -path ./.codex/tmp \) -prune \
    -o "$@"
}

snapshot() {
  user=$1
  home=$(home_of "$user")
  (
    cd "$home"
    home_files \( -type f -o -type l -o -type d \) -printf '%m %y %p %l\n' | LC_ALL=C sort
    home_files -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
    [ ! -f .t3/userdata/settings.json ] || { stat -c '%a %n' .t3/userdata/settings.json && sha256sum .t3/userdata/settings.json; }
  )
  # shellcheck disable=SC2016
  as_user "$user" env PATH="$home/.local/bin:$home/.bun/bin:/usr/local/bin:/usr/bin:/bin" /bin/sh -c '
    for cli in bun claude codex t3; do
      where=$(command -v "$cli") || { echo "$cli: not found"; continue; }
      echo "$cli: $where -> $(readlink -f "$where"): $("$cli" --version 2>&1 | head -1)"
    done' 2>&1
  printf '%s  crontab\n' "$(crontab -l -u "$user" 2>/dev/null | sha256sum | cut -d' ' -f1)"
  printf '%s  profile remote\n' "$(git -c safe.directory='*' --git-dir="$github/remotes/fleet-proof/fleet-profile.git" for-each-ref 2>/dev/null | sha256sum | cut -d' ' -f1)"
}

t3_port() {
  file="$(home_of "$1")/.t3/userdata/server-runtime.json"
  [ -f "$file" ] && sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$file"
}

open_needs() { sed -n '/needs these answers and sign-ins/,$p' "$1" | sed 1d | grep -v '^$' || true; }

only_signins() {
  needs=$(open_needs "$1")
  [ -n "$needs" ] && ! printf '%s\n' "$needs" | grep -v -q -E '^  Sign in to '
}

check_identity() {
  user=$1
  name=$(as_user "$user" git config --global --includes --get user.name || true)
  email=$(as_user "$user" git config --global --includes --get user.email || true)
  owner_email=
  [ -z "${SUDO_USER:-}" ] || owner_email=$(sudo -u "$SUDO_USER" -H git config --global --includes --get user.email 2>/dev/null || true)
  if [ "$name" = fleet-proof ] && [ "$email" = fleet-proof@users.noreply.github.com ] && [ "$email" != "$owner_email" ]; then
    pass "$user git author" "$name <$email>, not the box owner's"
  else
    fail "$user git author" "user.name=${name:-unset} user.email=${email:-unset}$([ -n "$owner_email" ] && [ "$email" = "$owner_email" ] && echo ' (the box owner'"'"'s email)')"
  fi
}

check_standalone() {
  user=$1
  home=$(home_of "$user")
  found=
  for file in .claude/settings.json .claude.json .codex/config.toml; do
    if [ ! -f "$home/$file" ]; then
      note "$file: absent"
      continue
    fi
    hits=$(grep -n -i -E 'ANTHROPIC_BASE_URL|OPENAI_BASE_URL|base_url|fleet-hub|proxy|tunnel|127\.0\.0\.1|localhost' "$home/$file" || true)
    if [ -n "$hits" ]; then
      found="$found ~/$file"
      printf '%s\n' "$hits" | sed "s|^|   ~/$file:|"
    else
      note "$file: no hub, tunnel, or proxy key"
    fi
  done
  if [ -z "$found" ]; then pass "$user standalone" "no hub, tunnel, or proxy key in the Claude and Codex settings"; else fail "$user standalone" "hub, tunnel, or proxy keys in$found"; fi
}

check_jobs() {
  user=$1
  table=$(crontab -l -u "$user" 2>/dev/null || true)
  printf '%s\n' "$table" | sed 's/^/   crontab: /'
  missing=
  for job in $jobs; do
    printf '%s\n' "$table" | grep -q "# fleet:$job\$" || missing="$missing $job"
  done
  if [ -z "$missing" ]; then pass "$user jobs" "crontab holds $jobs"; else fail "$user jobs" "crontab lacks$missing"; fi
}

check_seed() {
  user=$1
  home=$(home_of "$user")
  first="$work/$user-t3-first"
  note "$t3_unit drop-ins: $(as_user "$user" systemctl --user show -p DropInPaths --value "$t3_unit" 2>&1 | sed "s|$home|~|g")"
  if [ ! -e "$first/started" ]; then
    fail "$user T3 seeded first" "the proof's ExecStartPre never ran: $t3_unit did not start, or did not load the proof's drop-in"
  elif [ ! -f "$first/settings.json" ]; then
    fail "$user T3 seeded first" "the T3 Code settings file did not exist when $t3_unit first started"
  elif seeded=$(python3 -I - "$first/settings.json" "$home/.config/fleet/t3-settings.json" 2>&1 <<'EOF'
import json, sys

first, record = sys.argv[1:3]
try:
    copy = json.load(open(first))
except ValueError as error:
    sys.exit(f"the copy taken when T3 Code's service first started is not JSON: {error}")
try:
    fields = json.load(open(record)).get(".t3/userdata/settings.json", [])
except (OSError, ValueError) as error:
    sys.exit(f"cannot read Fleet's record of its T3 Code keys: {error}")
if not fields:
    sys.exit("Fleet's record lists no T3 Code keys")
absent = object()
wrong = []
for field in fields:
    value = copy
    for key in field["path"]:
        value = value.get(key, absent) if isinstance(value, dict) else absent
    if value != field["value"]:
        wrong.append(".".join(field["path"]) + ("" if value is absent else f"={json.dumps(value)}"))
names = ", ".join(".".join(field["path"]) for field in fields)
if wrong:
    sys.exit(f"when T3 Code's service first started, settings.json lacked Fleet's {', '.join(wrong)} (Fleet sets {names})")
print(f"all {len(fields)} of Fleet's keys, with Fleet's values: {names}")
EOF
  ); then
    pass "$user T3 seeded first" "when $t3_unit first started, settings.json held $seeded"
  else
    fail "$user T3 seeded first" "$seeded"
  fi
}

check_port() {
  user=$1
  uid=$(id -u "$user")
  port=$(t3_port "$user" || true)
  if [ -z "$port" ]; then
    fail "$user T3 runs" "T3 Code wrote no port to ~/.t3/userdata/server-runtime.json"
    as_user "$user" systemctl --user --no-pager status "$t3_unit" 2>&1 | head -15 | sed 's/^/   /' || true
    tail -n 15 "$(home_of "$user")/.t3/userdata/logs/boot-service.log" 2>/dev/null | sed 's/^/   boot-service.log: /' || true
    return
  fi
  listeners=$(ss -H -ltnp "sport = :$port" 2>/dev/null || true)
  [ -z "$listeners" ] || printf '%s\n' "$listeners" | sed 's/  */ /g; s/^/   listener: /'
  service=
  others=
  unknown=$(printf '%s\n' "$listeners" | grep -v '^$' | grep -c -v 'pid=[0-9]' || true)
  [ "$unknown" -eq 0 ] || others="$others $unknown listener(s) with no process information"
  for pid in $(printf '%s\n' "$listeners" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    owner=$(awk '/^Uid:/ { print $2 }' "/proc/$pid/status" 2>/dev/null || true)
    if [ "$owner" != "$uid" ]; then others="$others $pid (uid ${owner:-gone})"
    elif grep -q "/$t3_unit\$" "/proc/$pid/cgroup" 2>/dev/null; then service="$service $pid"
    else others="$others $pid ($user, outside $t3_unit)"
    fi
  done
  if [ -z "$listeners" ]; then
    fail "$user T3 runs" "server-runtime.json names port $port, but nothing listens on it"
  elif [ -n "$others" ]; then
    fail "$user T3 runs" "port $port has listeners other than $user's $t3_unit:$others"
  elif [ -z "$service" ]; then
    fail "$user T3 runs" "no process of $user's $t3_unit listens on port $port"
  else
    pass "$user T3 runs" "$user's $t3_unit (pid$service) listens on port $port, and no other process does"
  fi
}

check_get_sh_source() {
  user=$1
  if [ -z "$engine_git" ]; then
    note "public mode: install.sh fetches get.sh from public GitHub"
  elif grep -q . "$work/$user-get-sh-fetches" 2>/dev/null; then
    pass "$user get.sh source" "install.sh ran this tree's get.sh, served from $work/get.sh for $(sort -u "$work/$user-get-sh-fetches" | tr '\n' ' ')"
  else
    fail "$user get.sh source" "install.sh did not fetch get.sh from this tree, so it ran public GitHub's get.sh"
  fi
}

check_doctor() {
  user=$1
  log="$work/$user-doctor"
  say "$user: fleet doctor"
  logged "$log" fleet_cmd "$user" doctor >/dev/null
  code=$(cat "$log.code")
  open=$(grep -E '^(To do|Fix): ' "$log" || true)
  kept=$(grep -E '^Note: Kept your ' "$log" || true)
  if ! grep -q -E '^(Everything matches your profile\.|Run fleet apply to fix what Fleet can fix\.)$' "$log"; then
    fail "$user doctor" "fleet doctor did not finish (exit $code)"
  elif [ -n "$open" ]; then
    fail "$user doctor" "open items (exit $code): $(printf '%s' "$open" | tr '\n' '|')"
  elif [ -n "$kept" ]; then
    fail "$user doctor" "Fleet kept values that differ from the profile (exit $code): $(printf '%s' "$kept" | tr '\n' '|')"
  elif [ "$code" != 0 ] || ! grep -q -x 'Everything matches your profile.' "$log"; then
    fail "$user doctor" "fleet doctor exited $code"
  else
    pass "$user doctor" "everything matches the profile, nothing open (exit 0)"
  fi
}

check_rerun() {
  user=$1
  what=$2
  log=$3
  before=$4
  expect=$5
  after="$work/$user-after"
  snapshot "$user" >"$after"
  grep -E '^(bun|claude|codex|t3): ' "$after" | sed "s|$(home_of "$user")|~|g; s/^/   runtime: /"
  code=$(cat "$log.code")
  changes=$(grep -E '^(create|replace|remove) ' "$log" || true)
  case $expect in
    applied) outcome="exit 0 and Applied 0 changes."; [ "$code" = 0 ] && grep -q -x 'Applied 0 changes\.' "$log" && reached=yes || reached= ;;
    signins) outcome="exit 2 with only sign-ins open"; [ "$code" = 2 ] && only_signins "$log" && reached=yes || reached= ;;
  esac
  if [ -z "$reached" ]; then
    fail "$user rerun $what" "expected $outcome, got exit $code$(open_needs "$log" | tr '\n' '|' | sed 's/^./: &/')"
  elif cmp -s "$before" "$after" && [ -z "$changes" ] && ! grep -q -E '^Applied [1-9][0-9]* changes?\.$' "$log"; then
    pass "$user rerun $what" "$outcome, and nothing changed"
  else
    [ -z "$changes" ] || printf '%s\n' "$changes" | sed 's/^/   change: /'
    diff "$before" "$after" | sed 's/^/   diff: /' || true
    fail "$user rerun $what" "the rerun changed the machine"
  fi
}

say "Fleet fresh-Linux-user proof"
note "work folder $work"
mkdir -p "$github/remotes/fleet-proof"
chmod 755 "$github" "$github/remotes"
chmod 1777 "$github/remotes/fleet-proof"
for file in calls.log keys-authentication keys-signing; do : >"$github/$file"; chmod 666 "$github/$file"; done
git config --file "$work/gitconfig" "url.file://$github/remotes/fleet-proof/.insteadOf" https://github.com/fleet-proof/
git config --file "$work/gitconfig" safe.directory '*'
chmod 644 "$work/gitconfig"
engine_url=
engine_git=
if [ -n "$source_engine" ]; then
  if [ -d "$source_engine" ]; then
    commit=$(git -c safe.directory='*' -C "$source_engine" rev-parse HEAD)
  else
    commit=$(git bundle list-heads "$source_engine" | sed -n 's|^\([0-9a-f]*\) refs/heads/.*|\1|p' | head -1)
  fi
  [ -n "$commit" ] || die "FLEET_PROOF_ENGINE names no commit."
  engine_git="$work/engine.git"
  git -c safe.directory='*' clone -q --bare --no-local "$source_engine" "$engine_git"
  git --git-dir="$engine_git" update-ref "refs/heads/$ref" "$commit"
  git --git-dir="$engine_git" update-ref refs/heads/main "$commit"
  git --git-dir="$engine_git" show "$ref:get.sh" >"$work/get.sh"
  chmod -R a+rX "$work/engine.git" "$work/get.sh"
  engine_url="file://$engine_git"
  url="file://$work/get.sh"
  note "local mode: get.sh and the engine come from a local copy at $commit (ref $ref)"
else
  url="https://raw.githubusercontent.com/Silthus/fleet-engine/$ref/get.sh"
  note "public mode: get.sh and the engine come from $url"
fi
get_args=
[ "$ref" = main ] || get_args="--ref $ref"
oneliner="curl -fsSL $url | sh -s -- ${get_args:+$get_args }-- $setup_flags"

say "User A: a newcomer runs the one-liner"
make_user "$user_a" "$work/home-a"
note "\$ $oneliner"
code=$(logged "$work/a-run1" as_user "$user_a" sh -c "$oneliner")
note "exit $code"
gh_path=$(fleet_cmd_env "$user_a" sh -c 'command -v gh' || true)
note "gh for $user_a: ${gh_path:-none}"
if grep -q 'Git, gh, Bun and T3 Code are installed' "$work/a-run1" && grep -q '^  Sign in to GitHub: ' "$work/a-run1"; then
  pass "$user_a first run" "get.sh installed the tools, and setup stopped at the GitHub sign-in (exit $code)"
else
  fail "$user_a first run" "expected get.sh to install the tools and setup to stop at the GitHub sign-in (exit $code)"
fi

say "User A: signs in to GitHub (the sandbox account) and runs the one-liner again"
sign_in "$user_a"
note "\$ $oneliner"
code=$(logged "$work/a-run2" as_user "$user_a" sh -c "$oneliner")
note "exit $code"
needs=$(open_needs "$work/a-run2")
if [ -z "$needs" ]; then
  if grep -q 'Fleet is set up' "$work/a-run2"; then pass "$user_a setup" "setup finished (exit $code)"; else fail "$user_a setup" "setup ended without its done screen or a list of open items (exit $code)"; fi
elif printf '%s\n' "$needs" | grep -v -q -E '^  Sign in to '; then
  fail "$user_a setup" "setup left open items that are not sign-ins: $(printf '%s' "$needs" | tr '\n' '|')"
else
  pass "$user_a setup" "setup left only sign-ins open: $(printf '%s' "$needs" | sed 's/:.*//; s/^  //' | tr '\n' ',' | sed 's/,$//')"
fi
if [ -d "$github/remotes/fleet-proof/fleet-profile.git" ]; then
  note "setup created the profile repo fleet-proof/fleet-profile (a local bare repo)"
else
  note "setup did not create the profile repo"
fi

say "User A: checks"
check_identity "$user_a"
check_standalone "$user_a"
check_jobs "$user_a"
check_seed "$user_a"
check_port "$user_a"
check_path "$user_a"
check_codex "$user_a"
check_doctor "$user_a"

say "User A: fleet apply again"
snapshot "$user_a" >"$work/a-before"
note "\$ fleet apply"
code=$(logged "$work/a-apply" fleet_cmd "$user_a" apply)
note "exit $code"
check_rerun "$user_a" "fleet apply" "$work/a-apply" "$work/a-before" applied

say "User A: the one-liner again"
snapshot "$user_a" >"$work/a-before"
note "\$ $oneliner"
code=$(logged "$work/a-run3" as_user "$user_a" sh -c "$oneliner")
note "exit $code"
check_rerun "$user_a" "one-liner" "$work/a-run3" "$work/a-before" signins

say "User B: a devbox installs from the profile repo"
make_user "$user_b" "$work/home-b"
sign_in "$user_b"
profile="$(home_of "$user_b")/fleet-profile"
note "\$ git clone https://github.com/fleet-proof/fleet-profile.git ~/fleet-profile"
if as_user "$user_b" git clone -q https://github.com/fleet-proof/fleet-profile.git "$profile"; then
  note "\$ sh ~/fleet-profile/install.sh"
  code=$(logged "$work/b-run1" as_user "$user_b" sh "$profile/install.sh")
  note "exit $code"
  if [ "$code" = 0 ]; then pass "$user_b install" "install.sh applied the profile"; else fail "$user_b install" "install.sh exited $code"; fi
else
  fail "$user_b install" "could not clone the profile repo"
fi

say "User B: checks"
check_get_sh_source "$user_b"
check_identity "$user_b"
check_standalone "$user_b"
check_jobs "$user_b"
check_seed "$user_b"
check_port "$user_b"
check_path "$user_b"
check_codex "$user_b"
check_doctor "$user_b"

say "User B: fleet apply again"
snapshot "$user_b" >"$work/b-before"
note "\$ fleet apply"
code=$(logged "$work/b-apply" fleet_cmd "$user_b" apply)
note "exit $code"
check_rerun "$user_b" "fleet apply" "$work/b-apply" "$work/b-before" applied

say "User B: install.sh again"
snapshot "$user_b" >"$work/b-before"
note "\$ sh ~/fleet-profile/install.sh"
code=$(logged "$work/b-run2" as_user "$user_b" sh "$profile/install.sh")
note "exit $code"
check_rerun "$user_b" "install.sh" "$work/b-run2" "$work/b-before" applied

say "The sandbox gh calls"
sed 's/^/   /' "$github/calls.log"

say "Result"
if [ -s "$fails" ]; then
  sed 's/^/FAIL /' "$fails"
  exit 1
fi
echo "PASS every check"
