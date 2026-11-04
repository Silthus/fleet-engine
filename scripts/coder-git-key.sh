#!/bin/sh
# Runs Git's SSH and signing with the Coder account's Git SSH key, fetched from the
# Coder agent on each use. It needs no session environment, so the detached T3
# service can sign too.
#
#   coder-git-key.sh public           print the public key
#   coder-git-key.sh ssh <args>       ssh with the key to GitHub, for core.sshCommand
#   coder-git-key.sh -Y <args>        ssh-keygen with the key, for gpg.ssh.program
set -eu

agent_url=${CODER_AGENT_URL:-http://coder.internal/}
agent_url=${agent_url%/}
metadata=http://169.254.169.254/latest

agent_session() {
  imds_token=$(curl -fsS --max-time 5 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' "$metadata/api/token")
  signature=$(curl -fsS --max-time 5 -H "X-aws-ec2-metadata-token: $imds_token" "$metadata/dynamic/instance-identity/signature")
  document=$(curl -fsS --max-time 5 -H "X-aws-ec2-metadata-token: $imds_token" "$metadata/dynamic/instance-identity/document")
  jq -n --arg signature "$signature" --arg document "$document" '{$signature, $document}' |
    curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' -d @- \
      "$agent_url/api/v2/workspaceagents/aws-instance-identity" | jq -er .session_token
}

git_ssh_key() {
  session=$(agent_session)
  printf 'Coder-Session-Token: %s\n' "$session" |
    curl -fsS --max-time 10 -H @- "$agent_url/api/v2/workspaceagents/me/gitsshkey"
}

with_private_key() {
  umask 077
  key_file=$(mktemp "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/fleet-coder-git.XXXXXX")
  trap 'rm -f "$key_file"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  git_ssh_key | jq -er .private_key > "$key_file"
}

sign() {
  case " $* " in
    *" -Y sign "*) ;;
    *) exec ssh-keygen "$@" ;;
  esac
  with_private_key
  replace_next=no
  for argument; do
    shift
    if [ "$replace_next" = yes ]; then
      set -- "$@" "$key_file"
      replace_next=no
    elif [ "$argument" = -f ]; then
      set -- "$@" -f
      replace_next=yes
    elif [ "$argument" != -U ]; then
      set -- "$@" "$argument"
    fi
  done
  ssh-keygen "$@"
}

case "${1:-}" in
  public) git_ssh_key | jq -er .public_key ;;
  ssh)
    shift
    case " $* " in
      *"@github.com "*) ;;
      *) exec ssh "$@" ;;
    esac
    with_private_key
    ssh -F none -i "$key_file" -o IdentitiesOnly=yes -o IdentityAgent=none "$@"
    ;;
  -Y) sign "$@" ;;
  *)
    echo "Usage: coder-git-key.sh public | ssh <ssh arguments> | -Y <ssh-keygen arguments>" >&2
    exit 2
    ;;
esac
