#!/usr/bin/env bash
# Append one helm event for the project this directory resolves to. A project cannot record as
# another project: the name comes from the resolver, never from the caller. No helm: silent no-op.

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../profile-name.sh
. "$LIB/profile-name.sh"
export TILLER_HOME="${TILLER_HOME:-$(dirname "$LIB")}"
helm="${TILLER_HELM_DIR:-$TILLER_HOME/helm}"
[ -d "$helm/.git" ] || exit 0

if row="$(profile_name "$TILLER_HOME/profiles" "$PWD")"; then
  for a in "$@"; do
    case "$a" in --project|--project=*) echo "record: --project is refused inside project \"$row\"" >&2; exit 2 ;; esac
  done
  exec node "$LIB/helm/helm.mjs" record --project "$row" "$@"
fi
case " $* " in *" --project "*|*" --project="*) ;; *) echo "record: outside a project, --project <name> is required" >&2; exit 2 ;; esac
exec node "$LIB/helm/helm.mjs" record "$@"
