#!/usr/bin/env bash
# The doubt log: where a run records the decisions it took and wants a human to look at.
#
#   doubt-log.sh resolve --profile <profile.md> [--date YYYY-MM-DD] [<value>]   -> absolute path on stdout
#   doubt-log.sh append <absolute path>                                         -> stdin appended; parent created
#
# `<value>` is the profile's `- Doubt log:` field. Without it, $TILLER_DOUBT_LOG; without that,
# `doubts/<date>.md`. `~` expands to $HOME, `<date>` to the UTC date, and a relative path resolves
# against the profile's directory. This is the only resolver: profile-facts.sh renders its output,
# and everything downstream reads the rendered path. Exit 2 on usage.

set -uo pipefail

usage() { echo "usage: doubt-log.sh resolve --profile <file> [--date YYYY-MM-DD] [<value>] | append <absolute path>" >&2; exit 2; }

resolve() {
  local profile="" date="" value=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) profile="${2:-}"; shift 2 || usage ;;
      --date) date="${2:-}"; shift 2 || usage ;;
      *) value="$1"; shift ;;
    esac
  done
  [ -n "$profile" ] && [ -f "$profile" ] || usage
  [ -n "$date" ] || date="$(date -u +%Y-%m-%d)"
  [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || usage
  [ -n "$value" ] || value="${TILLER_DOUBT_LOG:-}"
  [ -n "$value" ] || value='doubts/<date>.md'

  value="${value//<date>/$date}"
  case "$value" in
    '~') value="$HOME" ;;
    '~/'*) value="$HOME/${value#\~/}" ;;
    /*) ;;
    *) value="$(cd "$(dirname "$profile")" && pwd)/$value" ;;
  esac
  printf '%s\n' "$value"
}

append() {
  [ $# -eq 1 ] || usage
  case "$1" in /*) ;; *) echo "doubt-log: not an absolute path: $1" >&2; exit 2 ;; esac
  case "$1" in *'<date>'*) echo "doubt-log: unresolved <date> in $1" >&2; exit 2 ;; esac
  mkdir -p "$(dirname "$1")" || exit 1
  cat >> "$1"
}

cmd="${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
  resolve) resolve "$@" ;;
  append) append "$@" ;;
  *) usage ;;
esac
