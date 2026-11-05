#!/bin/sh
# Fresh-Linux-user proof. Creates two new Linux users on this machine: A runs
# the public one-liner the way a newcomer does, and B installs from the profile
# repo A's setup made, the way a devbox does. It checks both, prints PASS or
# FAIL per check as it goes, then removes both users. Run it as root on a
# throwaway Linux box with systemd, cron, curl, git, and python3.
#
#   sudo sh proof/fresh-linux.sh
#   sudo FLEET_PROOF_ENGINE=<git repo or bundle> sh proof/fresh-linux.sh
#
# FLEET_PROOF_ENGINE serves get.sh and the engine from that copy, at its HEAD
# (or a bundle's first branch), while the engine repo is private. Without it,
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

say() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() { printf 'proof: %s\n' "$*" >&2; exit 2; }

[ "$(id -u)" -eq 0 ] || die "run this as root, with sudo."
[ "$(uname -s)" = Linux ] || die "this proof runs on Linux."
for tool in useradd userdel loginctl systemctl crontab curl git setsid sudo sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is missing."
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
watchers=

cleanup() {
  code=$?
  set +e
  say "Cleanup"
  for pid in $watchers; do kill "$pid" 2>/dev/null; done
  for user in $created; do
    uid=$(id -u "$user" 2>/dev/null) || continue
    loginctl disable-linger "$user" 2>/dev/null
    systemctl stop "user@$uid.service" 2>/dev/null
    pkill -KILL -u "$user" 2>/dev/null
    sleep 1
    crontab -r -u "$user" 2>/dev/null
    find /tmp /var/tmp -xdev -user "$user" -prune -exec rm -rf {} + 2>/dev/null
    userdel -r "$user" 2>/dev/null
    if id "$user" >/dev/null 2>&1; then note "could not remove $user"; else note "removed $user, its home, and its crontab"; fi
  done
  rm -rf "$work"
  note "removed $work"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

home_of() { getent passwd "$1" | cut -d: -f6; }

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
  where=$(fleet_cmd_env "$user" sh -c 'command -v codex' || true)
  node=$(fleet_cmd_env "$user" sh -c 'command -v node' || true)
  note "codex: ${where:-not found}; node: ${node:-not found}"
  if [ -n "$where" ]; then
    case "$(head -c 2 "$where" 2>/dev/null)" in
      '#!') note "codex launcher: $(head -1 "$where")" ;;
      *) note "codex launcher: a binary, $(readlink -f "$where")" ;;
    esac
  fi
  if version=$(fleet_cmd_env "$user" codex --version 2>&1); then
    pass "$user codex runs" "codex --version: $version"
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
  useradd -m -s /bin/bash -K UMASK=022 "$user"
  created="$created $user"
  home=$(home_of "$user")
  install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
  install -d -m 755 -o "$user" -g "$user" "$home/.proof" "$home/.proof/bin"
  loginctl enable-linger "$user"
  uid=$(id -u "$user")
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
  sed -e "s|__STATE__|$github|" -e "s|__ENGINE_GIT__|${engine_git:-none}|" "$here/sandbox-gh.sh" >"$home/.proof/bin/gh"
  chown "$user:$user" "$home/.proof/bin/gh"
  chmod 755 "$home/.proof/bin/gh"
  if [ -f "$home/.local/bin/gh" ]; then
    install -d -m 755 -o "$user" -g "$user" "$home/.proof/real"
    mv "$home/.local/bin/gh" "$home/.proof/real/gh"
    note "moved the real gh get.sh installed ($(as_user "$user" "$home/.proof/real/gh" --version | head -1)) to ~/.proof/real/gh"
  fi
  note "installed the sandbox gh at ~/.proof/bin/gh: signed in as fleet-proof"
}

watch_t3() {
  user=$1
  out=$2
  home=$(home_of "$user")
  uid=$(id -u "$user")
  while :; do
    now=$(date +%s.%N)
    if [ ! -s "$out.settings" ] && grep -q defaultThreadEnvMode "$home/.t3/userdata/settings.json" 2>/dev/null; then echo "$now" >"$out.settings"; fi
    if [ ! -s "$out.t3" ] && { [ -f "$home/.t3/userdata/server-runtime.json" ] || pgrep -u "$uid" -f '__service-launcher' >/dev/null 2>&1; }; then echo "$now" >"$out.t3"; fi
    sleep 0.2
  done
}

start_watch() {
  watch_t3 "$1" "$work/$1" &
  watchers="$watchers $!"
}

snapshot() {
  user=$1
  home=$(home_of "$user")
  (
    cd "$home"
    find . \( -path ./.t3 -o -path ./.cache -o -path ./.bun -o -path ./.npm -o -path ./.proof \
      -o -path ./.local/share/fleet/sources -o -path ./.local/share/fleet/engine/.git -o -path ./.local/state/fleet/logs \
      -o -path ./.local/share/claude -o -path ./.local/share/t3code -o -path ./.claude/statsig -o -path ./.claude/todos -o -path ./.codex/tmp \) -prune \
      -o -type f -print | LC_ALL=C sort | xargs -r -d '\n' sha256sum
    [ ! -f .t3/userdata/settings.json ] || sha256sum .t3/userdata/settings.json
  )
  printf '%s  crontab\n' "$(crontab -l -u "$user" 2>/dev/null | sha256sum | cut -d' ' -f1)"
  printf '%s  profile remote\n' "$(git -c safe.directory='*' --git-dir="$github/remotes/fleet-proof/fleet-profile.git" for-each-ref 2>/dev/null | sha256sum | cut -d' ' -f1)"
}

t3_port() {
  file="$(home_of "$1")/.t3/userdata/server-runtime.json"
  [ -f "$file" ] && sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$file"
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
  out="$work/$user"
  home=$(home_of "$user")
  settings=$(cat "$out.settings" 2>/dev/null || true)
  started=$(cat "$out.t3" 2>/dev/null || true)
  note "Fleet's keys first in ~/.t3/userdata/settings.json at ${settings:-never}; T3 Code's server first seen at ${started:-never}"
  [ ! -f "$home/.t3/userdata/server-runtime.json" ] || note "server-runtime.json: $(sed -n 's/.*\("startedAt":"[^"]*"\).*/\1/p' "$home/.t3/userdata/server-runtime.json")"
  if [ -z "$settings" ]; then
    fail "$user T3 seeded first" "Fleet's keys never reached ~/.t3/userdata/settings.json"
  elif [ -z "$started" ]; then
    pass "$user T3 seeded first" "settings.json holds Fleet's keys; T3 Code's server has not started"
  elif [ "$(awk -v a="$settings" -v b="$started" 'BEGIN { print (a < b) }')" = 1 ]; then
    pass "$user T3 seeded first" "settings.json held Fleet's keys before T3 Code's server started"
  else
    fail "$user T3 seeded first" "T3 Code's server started before Fleet's keys were in settings.json"
  fi
}

check_port() {
  user=$1
  port=$(t3_port "$user" || true)
  owner_port=
  [ -z "${SUDO_USER:-}" ] || owner_port=$(t3_port "$SUDO_USER" || true)
  note "T3 Code port: $user ${port:-none}, box owner ${owner_port:-none}$([ "$user" = "$user_b" ] && echo ", $user_a $(t3_port "$user_a" || echo none)")"
  if [ -z "$port" ]; then
    fail "$user T3 port" "T3 Code is not running for $user"
    as_user "$user" systemctl --user --no-pager status t3code.service 2>&1 | head -15 | sed 's/^/   /' || true
    tail -n 15 "$(home_of "$user")/.t3/userdata/logs/boot-service.log" 2>/dev/null | sed 's/^/   boot-service.log: /' || true
  elif [ "$port" = "$owner_port" ] || { [ "$user" = "$user_b" ] && [ "$port" = "$(t3_port "$user_a" || true)" ]; }; then
    fail "$user T3 port" "T3 Code uses port $port, which another user's T3 Code uses too"
  else
    pass "$user T3 port" "T3 Code runs on its own port $port"
  fi
}

check_doctor() {
  user=$1
  log="$work/$user-doctor"
  say "$user: fleet doctor"
  logged "$log" fleet_cmd "$user" doctor >/dev/null
  open=$(grep -E '^(To do|Fix): ' "$log" || true)
  others=$(printf '%s\n' "$open" | grep -v -i -E 'sign[ -]?in|log ?in' | grep -v '^$' || true)
  count=$(printf '%s\n' "$open" | grep -c -v '^$' || true)
  if ! grep -q -E '^(Everything matches your profile\.|Run fleet apply to fix what Fleet can fix\.)$' "$log"; then fail "$user doctor" "fleet doctor did not finish (exit $(cat "$log.code"))"
  elif [ -z "$others" ]; then pass "$user doctor" "$count open, all sign-ins (exit $(cat "$log.code"))"; else fail "$user doctor" "open items that are not sign-ins: $(printf '%s' "$others" | tr '\n' '|')"; fi
}

check_rerun() {
  user=$1
  what=$2
  log=$3
  before=$4
  after="$work/$user-after"
  snapshot "$user" >"$after"
  changes=$(grep -E '^(create|replace|remove) ' "$log" || true)
  if ! grep -q -E '^Applied [0-9]+ changes?\.$|Welcome back' "$log"; then
    fail "$user rerun $what" "the rerun did not reach fleet apply or fleet setup (exit $(cat "$log.code"))"
  elif cmp -s "$before" "$after" && [ -z "$changes" ] && ! grep -q -E '^Applied [1-9][0-9]* changes?\.$' "$log"; then
    pass "$user rerun $what" "nothing changed$(grep -o 'Applied [0-9]* changes\?\.' "$log" | tail -1 | sed 's/^/: /')"
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
  git -c safe.directory='*' clone -q --bare "$source_engine" "$engine_git"
  git --git-dir="$engine_git" update-ref "refs/heads/$ref" "$commit"
  git --git-dir="$engine_git" update-ref refs/heads/main "$commit"
  git --git-dir="$engine_git" show "$ref:get.sh" >"$work/get.sh"
  chmod -R a+rX "$work/engine.git" "$work/get.sh"
  engine_url="file://$engine_git"
  url="file://$work/get.sh"
  note "pre-flip mode: get.sh and the engine come from a local copy at $commit (ref $ref)"
else
  url="https://raw.githubusercontent.com/Silthus/fleet-engine/$ref/get.sh"
  note "public mode: get.sh and the engine come from $url"
fi
get_args=
[ "$ref" = main ] || get_args="--ref $ref"
oneliner="curl -fsSL $url | sh -s -- ${get_args:+$get_args }-- $setup_flags"

say "User A: a newcomer runs the one-liner"
make_user "$user_a"
start_watch "$user_a"
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
needs=$(sed -n '/needs these answers and sign-ins/,$p' "$work/a-run2" | sed 1d | grep -v '^$' || true)
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
check_rerun "$user_a" "fleet apply" "$work/a-apply" "$work/a-before"

say "User A: the one-liner again"
snapshot "$user_a" >"$work/a-before"
note "\$ $oneliner"
code=$(logged "$work/a-run3" as_user "$user_a" sh -c "$oneliner")
note "exit $code"
check_rerun "$user_a" "one-liner" "$work/a-run3" "$work/a-before"

say "User B: a devbox installs from the profile repo"
make_user "$user_b"
sign_in "$user_b"
start_watch "$user_b"
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
check_rerun "$user_b" "fleet apply" "$work/b-apply" "$work/b-before"

say "User B: install.sh again"
snapshot "$user_b" >"$work/b-before"
note "\$ sh ~/fleet-profile/install.sh"
code=$(logged "$work/b-run2" as_user "$user_b" sh "$profile/install.sh")
note "exit $code"
check_rerun "$user_b" "install.sh" "$work/b-run2" "$work/b-before"

say "The sandbox gh calls"
sed 's/^/   /' "$github/calls.log"

say "Result"
if [ -s "$fails" ]; then
  sed 's/^/FAIL /' "$fails"
  exit 1
fi
echo "PASS every check"
