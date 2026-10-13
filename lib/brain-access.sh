#!/usr/bin/env bash
# Edit brains/access.json, the matrix of which project may read or write which brain.
#
#   brain-access.sh                                      print the matrix, profiles x brains, _none last
#   brain-access.sh <profile|_none>                      pick one row: arrows move, space cycles
#                                                        none -> read -> write, enter saves, q quits
#   brain-access.sh --set <profile|_none> <brain> <none|read|write>
#
# The only writer of the matrix: saves are atomic (temp file + rename) and are followed by what the
# row now grants, as lib/resolve-brains.sh sees it. Exit 0 ok, 2 unknown name or level, 3 TILLER_HOME
# unset or the matrix could not be written.

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=profile-name.sh
. "$LIB/profile-name.sh"

{ [ -n "${TILLER_HOME:-}" ] && [ -d "$TILLER_HOME" ]; } || { echo "brain-access: TILLER_HOME unset or unreadable" >&2; exit 3; }
home="$(cd "$TILLER_HOME" && pwd -P)"
matrix="$home/brains/access.json"
mkdir -p "$home/brains" || exit 3
[ -f "$matrix" ] || echo '{}' >"$matrix" || { echo "brain-access: could not create $matrix" >&2; exit 3; }

profiles="$(list_names "$home/profiles" profile.md)"
brains="$(list_names "$home/brains")"

is_in() { printf '%s\n' "$2" | grep -qxF -- "$1"; }
check_row() { [ "$1" = _none ] || is_in "$1" "$profiles" || { echo "brain-access: no profile '$1'" >&2; exit 2; }; }
check_brain() { is_in "$1" "$brains" || { echo "brain-access: no brain '$1'" >&2; exit 2; }; }
level() { jq -r --arg r "$1" --arg b "$2" '.[$r][$b] // "none"' "$matrix"; }

# save_row <row> <JSON object brain -> level>: one atomic write; none cells and an empty row vanish.
save_row() {
  local tmp
  tmp="$(mktemp "$home/brains/.access.json.XXXXXX")" || { echo "brain-access: could not write $matrix" >&2; exit 3; }
  if jq --arg r "$1" --argjson cells "$2" \
      '.[$r] = ((.[$r] // {}) + $cells | with_entries(select(.value != "none"))) | if .[$r] == {} then del(.[$r]) else . end' \
      "$matrix" >"$tmp" && mv "$tmp" "$matrix"; then
    echo "$1 now grants:"
    "$LIB/resolve-brains.sh" --row "$1" || true
  else
    rm -f "$tmp"; echo "brain-access: could not write $matrix" >&2; exit 3
  fi
}

print_table() {
  local r b line
  line="profile"
  while IFS= read -r b; do [ -n "$b" ] && line="$line	$b"; done <<<"$brains"
  printf '%s\n' "$line"
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    line="$r"
    while IFS= read -r b; do [ -n "$b" ] && line="$line	$(level "$r" "$b")"; done <<<"$brains"
    printf '%s\n' "$line"
  done <<<"$(printf '%s\n_none\n' "$profiles")"
}

pick_row() {
  local row="$1" i=0 j n key b cells levels=() names=()
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    names+=("$b"); levels+=("$(level "$row" "$b")")
  done <<<"$brains"
  n="${#names[@]}"
  [ "$n" -gt 0 ] || { echo "brain-access: no brains under $home/brains" >&2; return 0; }
  while :; do
    [ -t 2 ] && printf '\033[H\033[2J' >&2
    echo "$row — arrows move, space cycles, enter saves, q quits" >&2
    for ((j = 0; j < n; j++)); do
      [ "$j" = "$i" ] && printf '> ' >&2 || printf '  ' >&2
      printf '%-24s %s\n' "${names[$j]}" "${levels[$j]}" >&2
    done
    IFS= read -rsn1 key || { echo "not saved" >&2; return 0; }
    case "$key" in
      $'\033') IFS= read -rsn2 key; case "$key" in '[A') [ "$i" -gt 0 ] && i=$((i - 1)) ;; '[B') [ "$i" -lt $((n - 1)) ] && i=$((i + 1)) ;; esac ;;
      ' ') case "${levels[$i]}" in none) levels[$i]=read ;; read) levels[$i]=write ;; *) levels[$i]=none ;; esac ;;
      q) echo "not saved" >&2; return 0 ;;
      '') cells="$(for ((j = 0; j < n; j++)); do printf '%s\t%s\n' "${names[$j]}" "${levels[$j]}"; done |
                  jq -Rn '[inputs | split("\t") | {key: .[0], value: .[1]}] | from_entries')"
          save_row "$row" "$cells"; return 0 ;;
    esac
  done
}

case "${1:-}" in
  "") print_table | column -t -s "$(printf '\t')" ;;
  --set)
    [ "$#" -eq 4 ] || { echo "usage: brain-access.sh --set <profile|_none> <brain> <none|read|write>" >&2; exit 2; }
    check_row "$2"; check_brain "$3"
    case "$4" in none|read|write) ;; *) echo "brain-access: unknown level '$4'" >&2; exit 2 ;; esac
    save_row "$2" "$(jq -cn --arg b "$3" --arg l "$4" '{($b): $l}')" ;;
  -*) echo "usage: brain-access.sh [<profile|_none> | --set <profile|_none> <brain> <level>]" >&2; exit 2 ;;
  *) check_row "$1"; pick_row "$1" ;;
esac
