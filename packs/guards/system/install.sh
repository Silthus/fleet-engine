#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
mode=${1:-install}
root=${2:-}
etc=$root/etc/fleet
config=$etc/git-allowlist.gitconfig
helper=$root/usr/local/bin/git-remote-fleet-blocked
ssh_check=$root/usr/local/bin/fleet-git-ssh
system=$root/etc/gitconfig
included() { git config --file "$system" --get-all include.path 2>/dev/null | grep -qxF "$config"; }

for target in "$etc" "$etc/git-allowlist" "$etc/git-allowlist.sig" "$etc/git-allowlist-signers" "$config" "$helper" "$ssh_check" "$system"; do
  if [ -L "$target" ]; then
    echo "Git allowlist: $target is a symbolic link. Nothing changed." >&2
    exit 1
  fi
done

if [ "$mode" = remove ]; then
  if included; then git config --file "$system" --fixed-value --unset-all include.path "$config"; fi
  rm -f "$config" "$etc/git-allowlist" "$etc/git-allowlist.sig" "$etc/git-allowlist-signers" "$helper" "$ssh_check"
  echo "Git allowlist: off."
  exit 0
fi
[ "$mode" = install ] || { echo "usage: sh install.sh [install|remove] [system root]" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$here/git-allowlist" "$here/git-allowlist.sig" "$here/git-allowlist-signers" "$work/"
signers=$etc/git-allowlist-signers
[ -e "$signers" ] || signers=$work/git-allowlist-signers
if ! ssh-keygen -Y verify -f "$signers" -I fleet-allowlist -n fleet-git-allowlist -s "$work/git-allowlist.sig" < "$work/git-allowlist" >/dev/null 2>&1; then
  echo "Git allowlist: the list does not verify against $signers. Nothing changed." >&2
  exit 1
fi

ssh_user=git

section() {
  printf '[url "%s"]\n' "$1"
  shift
  for prefix in "$@"; do printf '  insteadOf = %s\n  pushInsteadOf = %s\n' "$prefix" "$prefix"; done
}
{
  echo "# Managed by Fleet's Guards pack from the signed Git allowlist. Do not edit."
  printf '[protocol "fleet-blocked"]\n  allow = always\n'
  printf '[core]\n  sshCommand = %s\n' "$ssh_check"
  printf '[ssh]\n  variant = ssh\n'
  for prefix in https:// http:// git:// ssh:// git@ https:: http:: github.com: ssh.github.com: https://github.com/ http://github.com/ git://github.com/ ssh://${ssh_user}@github.com/ ${ssh_user}@github.com:; do
    section "fleet-blocked::$prefix" "$prefix"
  done
  while IFS= read -r owner; do
    case "$owner" in
      "" | "#"*) continue ;;
      -* | *- | *[!A-Za-z0-9-]*) echo "Git allowlist: $owner is not a GitHub owner name. Nothing changed." >&2; exit 1 ;;
    esac
    section "ssh://${ssh_user}@ssh.github.com:443/$owner/" "ssh://${ssh_user}@ssh.github.com:443/$owner/"
    section "${ssh_user}@github.com:$owner/" "${ssh_user}@github.com:$owner/" "ssh://${ssh_user}@github.com/$owner/" "ssh://${ssh_user}@github.com:22/$owner/"
    section "github.com:$owner/" "github.com:$owner/"
    section "https://github.com/$owner/" "https://github.com/$owner/" "https://github.com:443/$owner/" "git://github.com/$owner/" "https::https://github.com/$owner/"
  done < "$work/git-allowlist"
} > "$work/git-allowlist.gitconfig"

cat > "$work/git-remote-fleet-blocked" <<'HELPER'
#!/bin/sh
url=$(printf '%s' "${2:-${1:-}}" | sed -e 's#//[^/@]*@#//<redacted>@#' -e 's/?.*$/?<redacted>/')
person=$(sed -n 's/^ *"guards.person": *"\([^"]*\)".*/\1/p' "$HOME/.local/state/fleet/settings.json" 2>/dev/null)
echo "fatal: Fleet blocked Git access to $url: its owner is not on the signed Git allowlist. Stop and ask ${person:-the person who runs this machine}. Do not retry, change the URL, or work around the block." >&2
exit 1
HELPER

{
  echo '#!/bin/sh'
  printf "list='%s'\n" "$etc/git-allowlist"
  cat <<'CHECK'
host= command=
for arg do host=$command; command=$arg; done
host=$(printf '%s' "${host#*@}" | tr '[:upper:]' '[:lower:]')
owner=$(printf '%s' "$command" | sed -n "s#^git-[a-z-]* '/*\([A-Za-z0-9-]*\)/[^']*'\$#\1#p")
if { [ "$host" = github.com ] || [ "$host" = ssh.github.com ]; } && grep -qixF -- "$owner" "$list"; then exec ssh "$@"; fi
person=$(sed -n 's/^ *"guards.person": *"\([^"]*\)".*/\1/p' "$HOME/.local/state/fleet/settings.json" 2>/dev/null)
echo "fatal: Fleet blocked Git access over SSH to $host: its owner is not on the signed Git allowlist. Stop and ask ${person:-the person who runs this machine}. Do not retry, change the URL, or work around the block." >&2
exit 1
CHECK
} > "$work/fleet-git-ssh"

install -d -m 755 "$etc" "${helper%/*}"
[ -e "$etc/git-allowlist-signers" ] || install -m 644 "$work/git-allowlist-signers" "$etc/git-allowlist-signers"
install -m 644 "$work/git-allowlist" "$etc/git-allowlist"
install -m 644 "$work/git-allowlist.sig" "$etc/git-allowlist.sig"
install -m 644 "$work/git-allowlist.gitconfig" "$config"
install -m 755 "$work/git-remote-fleet-blocked" "$helper"
install -m 755 "$work/fleet-git-ssh" "$ssh_check"
included || git config --file "$system" --add include.path "$config"
echo "Git allowlist: on."
