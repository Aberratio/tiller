#!/usr/bin/env bash
# Resolve the brains a working directory may use.
#
#   resolve-brains.sh [<dir>]              -> grants of the profile <dir> resolves to, or of _none
#   resolve-brains.sh --row <name|_none>   -> grants of that row
#
# Prints one line per granted brain: <name>\t<read|write>\t<absolute path>. A missing row or cell is
# none and prints nothing. A brain skill takes its paths from here and never hardcodes a vault.
# Exit 0 ok, 2 matrix invalid, 3 TILLER_HOME unset or unreadable, 4 a profile is named
# (TILLER_PROFILE, .tiller-profile) but does not exist.

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=profile-name.sh
. "$LIB/profile-name.sh"

{ [ -n "${TILLER_HOME:-}" ] && [ -d "$TILLER_HOME" ] && [ -r "$TILLER_HOME" ]; } \
  || { echo "resolve-brains: TILLER_HOME unset or unreadable" >&2; exit 3; }
home="$(cd "$TILLER_HOME" && pwd -P)"
matrix="$home/brains/access.json"

if [ "${1:-}" = "--row" ]; then
  row="${2:-}"
  [ -n "$row" ] || { echo "resolve-brains: --row needs a name" >&2; exit 3; }
else
  target="$(cd "${1:-$PWD}" 2>/dev/null && pwd)" || { echo "resolve-brains: no such dir" >&2; exit 3; }
  if row="$(profile_name "$home/profiles" "$target")"; then
    [ -f "$home/profiles/$row/profile.md" ] || { echo "resolve-brains: no profile '$row'" >&2; exit 4; }
  else
    row=_none
  fi
fi

[ -f "$matrix" ] || exit 0

profiles="$(list_names "$home/profiles" profile.md | jq -R . | jq -sc .)"
brains="$(list_names "$home/brains" | jq -R . | jq -sc .)"
problems="$(jq -r --argjson profiles "$profiles" --argjson brains "$brains" '
  if type != "object" then "the matrix is not an object" else
  to_entries[] | .key as $row |
  if $row != "_none" and ($profiles | any(. == $row) | not) then "row \"\($row)\": no such profile"
  elif (.value | type) != "object" then "row \"\($row)\": not an object"
  else .value | to_entries[] |
    if (.key as $b | $brains | any(. == $b) | not) then "row \"\($row)\": no such brain \"\(.key)\""
    elif (.value | type) != "string" or ([.value] | inside(["none", "read", "write"]) | not)
      then "row \"\($row)\", brain \"\(.key)\": unknown level \(.value | tojson)"
    else empty end
  end end' "$matrix" 2>/dev/null)" \
  || { echo "resolve-brains: brains/access.json is not valid JSON" >&2; exit 2; }
if [ -n "$problems" ]; then
  printf 'resolve-brains: %s (brains/access.json)\n' "$problems" >&2
  exit 2
fi

jq -r --arg row "$row" '(.[$row] // {}) | to_entries[] | select(.value != "none") | "\(.key)\t\(.value)"' "$matrix" |
  while IFS="$(printf '\t')" read -r name level; do
    printf '%s\t%s\t%s\n' "$name" "$level" "$home/brains/$name"
  done
