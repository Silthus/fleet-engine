#!/bin/sh
# Fleet bootstrap. Installs what Fleet needs, fetches the engine at a pinned
# ref, installs its packages, puts fleet on the login PATH, then runs
# fleet setup, or fleet apply when --profile names a profile.
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
fail() {
  say "$*"
  [ "$(sed -n 2p "$HOME/.local/bin/fleet" 2>/dev/null)" != "# Fleet" ] || say "Stuck? Run fleet triage. It shows a report of this setup that you can send to the Fleet maintainer."
  exit 1
}
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

# fleet setup reads this log to time the whole install, from this line on.
install_log="$HOME/.local/state/fleet/logs/install-timings"
needed_you=
mkdir -p "${install_log%/*}"
printf 'start %s\n' "$(date +%s)" >"$install_log"
ended() { printf '%s %s%s\n' "$1" "$(date +%s)" "${2:+ $2}" >>"$install_log"; }

retry() {
  tries=1
  until "$@"; do
    [ "$tries" -lt 3 ] || return 1
    sleep "$tries"
    tries=$((tries + 1))
  done
}

fetch_once() {
  out=$(curl -fsSL --connect-timeout 20 --speed-limit 1024 --speed-time 60 "$@") && printf '%s' "$out"
}

fetch() { retry fetch_once "$@"; }

download() {
  file=$(mktemp)
  fetch "$1" -o "$file" || fail "could not download $1."
  printf '%s\n' "$file"
}

mac_tools() {
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  if ! xcode-select -p >/dev/null 2>&1; then
    say "Installing the Command Line Tools. Finish the window that opens; this script waits."
    needed_you=needed-you
    xcode-select --install >/dev/null 2>&1 || true
    until xcode-select -p >/dev/null 2>&1; do sleep 5; done
  fi
  if ! has brew; then
    say "Installing Homebrew. It asks for your Mac password once."
    needed_you=needed-you
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
  latest=$(fetch -I -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest) || fail "could not find the latest gh release."
  version=${latest##*/v}
  name="gh_${version}_linux_${arch}"
  work=$(mktemp -d)
  fetch "https://github.com/cli/cli/releases/download/v$version/$name.tar.gz" -o "$work/gh.tar.gz" || fail "could not download gh."
  fetch "https://github.com/cli/cli/releases/download/v$version/gh_${version}_checksums.txt" -o "$work/sums" || fail "could not download gh checksums."
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
  fetch "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/bun-$target.zip" -o "$work/bun.zip" || fail "could not download Bun."
  echo "$sum  $work/bun.zip" | sha256sum -c --status - || fail "Bun checksum mismatch."
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$work/bun.zip" "$work"
  mkdir -p "$HOME/.bun/bin"
  install -m 755 "$work/bun-$target/bun" "$HOME/.bun/bin/bun"
  rm -rf "$work"
}

t3_nightly() {
  feed=$(fetch https://github.com/pingdotgg/t3code/releases.atom) || return 0
  printf '%s\n' "$feed" | sed -n 's|.*/releases/tag/v\([0-9][0-9.]*-nightly\.[0-9]*\.[0-9]*\)".*|\1|p' | head -n 1
}

t3_cli() {
  has t3 && return 0
  installer=$(download https://t3.codes/install.sh)
  version=$(t3_nightly)
  limited=$(mktemp -d)
  quoted=$(command -v curl | sed "s/'/'\\\\''/g")
  printf "#!/bin/sh\nexec '%s' --connect-timeout 20 --speed-limit 1024 --speed-time 60 \"\$@\"\n" "$quoted" >"$limited/curl"
  chmod 755 "$limited/curl"
  installed=
  retry env PATH="$limited:$PATH" T3CODE_CHANNEL=nightly T3CODE_VERSION="$version" sh "$installer" && installed=1
  rm -rf "$limited"
  [ -n "$installed" ] || fail "T3 Code did not install."
}

fetch_engine() {
  if [ -d "$engine_dir" ] && [ ! -d "$engine_dir/.git" ] && [ -n "$(ls -A "$engine_dir")" ]; then
    fail "$engine_dir holds files that are not a Fleet engine. Move them away, or set FLEET_ENGINE_DIR."
  fi
  mkdir -p "$engine_dir"
  engine_dir=$(CDPATH='' cd -- "$engine_dir" && pwd)
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

install_packages() {
  log=$(mktemp)
  if ! (cd "$engine_dir" && bun install --frozen-lockfile --production) >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$log"
    fail "could not install the engine's packages in $engine_dir."
  fi
  rm -f "$log"
}

link_fleet() {
  bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir"
  if { [ -e "$bin_dir/fleet" ] || [ -L "$bin_dir/fleet" ]; } && [ "$(sed -n 2p "$bin_dir/fleet" 2>/dev/null)" != "# Fleet" ]; then
    say "$bin_dir/fleet is not Fleet's, so it stays as it is. Run Fleet with sh $engine_dir/fleet."
    return 0
  fi
  quoted=$(printf '%s' "$engine_dir/fleet" | sed "s/'/'\\\\''/g")
  wrapper=$(mktemp "$bin_dir/fleet.XXXXXX")
  printf "#!/bin/sh\n# Fleet\nexec sh '%s' \"\$@\"\n" "$quoted" >"$wrapper"
  chmod 755 "$wrapper"
  mv -f "$wrapper" "$bin_dir/fleet"
}

add_login_line() {
  [ ! -s "$1" ] || [ -z "$(tail -c 1 "$1")" ] || printf '\n' >>"$1"
  printf '%s\n' "$2" >>"$1"
}

login_path() {
  dirs="\$HOME/.local/bin \$HOME/.bun/bin"
  shell=${SHELL:-}
  if [ "$(uname -s)" = Darwin ]; then
    dirs="$dirs /opt/homebrew/bin"
    [ -n "$shell" ] || shell=zsh
  fi
  case "${shell##*/}" in
    zsh) file=.zprofile ;;
    bash) file=.profile; [ ! -f "$HOME/.bash_login" ] || file=.bash_login; [ ! -f "$HOME/.bash_profile" ] || file=.bash_profile ;;
    fish) file=.config/fish/conf.d/fleet.fish ;;
    *) file=.profile ;;
  esac
  if [ "$file" = .config/fish/conf.d/fleet.fish ]; then
    line="fish_add_path --global $dirs"
    [ "$(cat "$HOME/$file" 2>/dev/null)" != "$line" ] || return 0
    mkdir -p "$HOME/.config/fish/conf.d"
    printf '%s\n' "$line" >"$HOME/$file"
  else
    line="export PATH=\"$(printf '%s' "$dirs" | tr ' ' ':'):\$PATH\" # Added by Fleet"
    ! grep -qxF "$line" "$HOME/$file" 2>/dev/null || return 0
    add_login_line "$HOME/$file" "$line"
  fi
  say "Open a new terminal to use fleet. ~/$file now puts ~/.local/bin and ~/.bun/bin on your PATH."
}

case "$(uname -s)" in
  Darwin) mac_tools ;;
  Linux)
    for tool in curl git tar sha256sum python3; do has "$tool" || fail "install $tool first."; done
    has gh || linux_gh
    has bun || linux_bun ;;
  *) fail "Fleet runs on macOS and Linux." ;;
esac
ended tools "$needed_you"
t3_cli
ended t3
has git || fail "git is missing."
fetch_engine
ended engine
install_packages
ended packages
link_fleet
login_path
say "Engine ready at $ref in $engine_dir."

[ -z "$install_only" ] || exit 0

if [ -n "$profile" ]; then
  exec sh "$engine_dir/fleet" apply --profile "$profile" "$@"
fi
if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
  exec sh "$engine_dir/fleet" setup "$@" </dev/tty
fi
exec sh "$engine_dir/fleet" setup "$@"
