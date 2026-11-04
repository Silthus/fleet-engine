#!/bin/sh
ref=$(sed -n '/"engine"/,/}/s/.*"ref": *"\([^"]*\)".*/\1/p' "$(dirname "$0")/fleet.json" | head -n 1)
curl -fsSL "https://raw.githubusercontent.com/Silthus/fleet-engine/${ref:-main}/get.sh" | sh -s -- --ref "${ref:-main}" --profile "$(cd "$(dirname "$0")" && pwd -P)"
