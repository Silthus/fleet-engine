#!/bin/sh
# A sandbox gh for the fresh-Linux-user proof: a signed-in GitHub account
# fleet-proof whose repos are bare repos under the proof's work folder.
# fresh-linux.sh installs it with the two paths below filled in.
#
#   gh <the calls fleet setup, fleet apply, and install.sh make>
set -eu

state=__STATE__
engine_git=__ENGINE_GIT__
login=fleet-proof
email=fleet-proof@users.noreply.github.com
scopes="'repo', 'read:org', 'admin:public_key', 'admin:ssh_signing_key', 'workflow'"

printf '%s: gh %s\n' "$(id -un)" "$*" >>"$state/calls.log"

refuse() {
  printf '%s\n' "$1" >&2
  exit 1
}

keys() {
  file="$state/keys-$1"
  [ "$2" = ".[].key" ] || refuse "fleet-proof sandbox gh: api user keys only answers --jq .[].key"
  cat "$file"
}

contents() {
  file=${1#repos/Silthus/fleet-engine/contents/}
  ref=main
  case "$file" in
    *"?ref="*) ref=${file#*\?ref=}; file=${file%%\?*} ;;
  esac
  [ "$engine_git" != none ] || refuse "HTTP 404: Not Found (https://api.github.com/$1)"
  git -c safe.directory='*' --git-dir="$engine_git" show "$ref:$file" 2>/dev/null || refuse "HTTP 404: Not Found (https://api.github.com/$1)"
}

api() {
  path=
  jq=
  while [ $# -gt 0 ]; do
    case "$1" in
      --jq | -q) jq=$2; shift 2 ;;
      -H | --header | -X | --method | --input | -f | -F | --field | --raw-field) shift 2 ;;
      -*) shift ;;
      *) [ -n "$path" ] || path=$1; shift ;;
    esac
  done
  case "$path" in
    user)
      if [ "$jq" = .login ]; then
        echo "$login"
      else
        printf '{"login":"%s","id":1000001,"name":null,"email":null}\n' "$login"
      fi ;;
    user/emails) printf '[{"email":"%s","primary":true,"verified":true,"visibility":"public"}]\n' "$email" ;;
    user/keys) keys authentication "$jq" ;;
    user/ssh_signing_keys) keys signing "$jq" ;;
    user/memberships/orgs/*) refuse "HTTP 404: Not Found (https://api.github.com/$path)" ;;
    repos/Silthus/fleet-engine/contents/*) contents "$path" ;;
    *) refuse "fleet-proof sandbox gh: api $path is not part of the proof" ;;
  esac
}

repo() {
  name=${2:-}
  case "$name" in
    "$login"/*) ;;
    *) refuse "GraphQL: Could not resolve to a Repository with the name '$name'. (repository)" ;;
  esac
  case "$1" in
    view)
      [ -d "$state/remotes/$name.git" ] || refuse "GraphQL: Could not resolve to a Repository with the name '$name'. (repository)"
      printf '{"name":"%s"}\n' "${name#*/}" ;;
    create)
      [ ! -e "$state/remotes/$name.git" ] || refuse "GraphQL: Name already exists on this account (createRepository)"
      git init -q --bare -b main "$state/remotes/$name.git"
      echo "✓ Created repository $name on GitHub (fleet-proof sandbox)" ;;
    *) refuse "fleet-proof sandbox gh: repo $1 is not part of the proof" ;;
  esac
}

ssh_key() {
  [ "${1:-}" = add ] || refuse "fleet-proof sandbox gh: ssh-key ${1:-} is not part of the proof"
  file=$2
  type=authentication
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --type) type=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  cut -d' ' -f1-2 "$file" >>"$state/keys-$type"
  echo "✓ Public key added to your account (fleet-proof sandbox)"
}

case "${1:-}" in
  --version) echo "gh version 0.0.0 (fleet-proof sandbox)" ;;
  auth)
    case "${2:-}" in
      status) printf 'github.com\n  ✓ Logged in to github.com account %s (fleet-proof sandbox)\n  - Active account: true\n  - Token scopes: %s\n' "$login" "$scopes" ;;
      setup-git) ;;
      *) refuse "fleet-proof sandbox gh: auth ${2:-} is not part of the proof" ;;
    esac ;;
  api) shift; api "$@" ;;
  repo) shift; repo "$@" ;;
  ssh-key) shift; ssh_key "$@" ;;
  pr) [ "${2:-}" = list ] || refuse "fleet-proof sandbox gh: pr ${2:-} is not part of the proof"; echo 0 ;;
  *) refuse "fleet-proof sandbox gh: $* is not part of the proof" ;;
esac
