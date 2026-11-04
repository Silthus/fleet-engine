#!/bin/sh
# Scans the commits in <base>..HEAD for secrets and deny-listed private terms.
# The deny-list comes from FLEET_PRIVACY_DENYLIST: one extended regex per line,
# matched case-insensitively. Lines starting with # are comments. The scan
# fails closed when the list is missing, and never prints a matched term.
set -eu

base=${1:?usage: privacy-scan.sh <base-commit>}

patterns=$(mktemp)
trap 'rm -f "$patterns"' EXIT
printf '%s\n' "${FLEET_PRIVACY_DENYLIST:-}" | grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' >"$patterns" || true
if [ ! -s "$patterns" ]; then
  echo "privacy: FLEET_PRIVACY_DENYLIST is missing or empty; failing closed." >&2
  exit 2
fi

failed=0

if ! gitleaks git --log-opts="$base..HEAD" --redact --verbose --no-banner .; then
  echo "privacy: gitleaks found a secret in $base..HEAD." >&2
  failed=1
fi

hits=$(git diff --name-only -z --diff-filter=d "$base" HEAD |
  xargs -0 grep -H -n -I -i -E -f "$patterns" -- 2>/dev/null |
  cut -d: -f1,2) || true
if [ -n "$hits" ]; then
  printf '%s\n' "$hits" | sed 's/$/ matches a deny-list term./' >&2
  failed=1
fi

for commit in $(git rev-list "$base..HEAD"); do
  if git log -1 --format=%B "$commit" | grep -q -i -E -f "$patterns"; then
    echo "privacy: the commit message of $commit matches a deny-list term." >&2
    failed=1
  fi
done

exit "$failed"
