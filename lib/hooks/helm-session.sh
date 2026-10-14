#!/usr/bin/env bash
# SessionStart hook: sync the helm, refresh this machine's file, print what is due. A project
# session sees only its own project. Never fails the session: no helm or any error prints nothing.

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../profile-name.sh
. "$LIB/profile-name.sh"
export TILLER_HOME="${TILLER_HOME:-$(dirname "$LIB")}"

input="$(cat)"
cwd="$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)"
cwd="${cwd:-$PWD}"
row="$(profile_name "$TILLER_HOME/profiles" "$cwd")" || row=_none
node "$LIB/helm/helm.mjs" session --row "$row" --cwd "$cwd" || true
exit 0
