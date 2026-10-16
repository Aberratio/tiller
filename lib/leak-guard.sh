#!/usr/bin/env bash
# Refuse tracked content that names a local project, a person, a credential, or a private agent record.
#
#   leak-guard.sh            scan every file git would track (all non-ignored files)
#   leak-guard.sh --staged   scan only what is staged (the pre-commit hook)
#
# Terms come from the local, ignored lists: profiles/*/leak-terms.txt and personal/*/leak-terms.txt,
# one case-insensitive extended regex per line, `#` for comments. The harness itself names no
# project, so the lists that say what must not leak live with the projects they describe.
# Exit 0 clean, 1 on a hit, 2 on usage.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-all}"

# Credential shapes, independent of any profile.
SECRETS='(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
# Private agent records: a path nobody else can open, and one that names whose machine it is.
PRIVATE='(~|\$HOME|/Users/[^/ ]+|/home/[^/ ]+)/\.claude/(plans|projects|memory|qa-evidence|meeting-notes|[A-Za-z0-9_-]+-reflections)/'

terms="$(mktemp "${TMPDIR:-/tmp}/leak-terms.XXXXXX")"
trap 'rm -f "$terms"' EXIT
for f in "$ROOT"/profiles/*/leak-terms.txt "$ROOT"/personal/*/leak-terms.txt; do
  [ -f "$f" ] || continue
  case "$f" in */_template/*|*/_templates/*) continue ;; esac
  grep -vE '^\s*(#|$)' "$f" >> "$terms"
done

files=()
if [ "$mode" = "--staged" ]; then
  while IFS= read -r -d '' f; do files+=("$f"); done < <(git -C "$ROOT" diff --cached --name-only --diff-filter=ACMR -z)
elif [ "$mode" = "all" ]; then
  if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    while IFS= read -r -d '' f; do files+=("$f"); done < <(git -C "$ROOT" ls-files -co --exclude-standard -z)
  else
    while IFS= read -r -d '' f; do files+=("${f#./}"); done < <(cd "$ROOT" && find . -type f \
      ! -path './.git/*' \( ! -path './profiles/*' -o -path './profiles/_template/*' \) \
      \( ! -path './personal/*' -o -path './personal/_templates/*' \) -print0)
  fi
else
  echo "usage: leak-guard.sh [--staged]" >&2; exit 2
fi

hits=0
for f in "${files[@]}"; do
  case "$f" in lib/leak-guard.sh) continue ;; esac
  # The licence holder and the conduct contact are public on purpose; those two files skip the term list.
  case "$f" in LICENSE|CODE_OF_CONDUCT.md) scan_terms=0 ;; *) scan_terms=1 ;; esac
  path="$ROOT/$f"
  [ -f "$path" ] || continue
  if [ "$mode" = "--staged" ]; then content() { git -C "$ROOT" show ":$f"; }; else content() { cat "$path"; }; fi
  # The path itself can leak a name too.
  if [ -s "$terms" ] && printf '%s\n' "$f" | grep -qiEf "$terms"; then
    echo "leak: path $f"; hits=$((hits+1))
  fi
  out="$( { [ -s "$terms" ] && [ "$scan_terms" = 1 ] && content | grep -nIiEf "$terms"; content | grep -nIE "$SECRETS"; content | grep -nIE "$PRIVATE"; } 2>/dev/null | head -5)"
  if [ -n "$out" ]; then
    printf '%s\n' "$out" | sed "s|^|leak: $f:|"; hits=$((hits+1))
  fi
done

if [ "$hits" -gt 0 ]; then
  echo "leak-guard: $hits file(s) carry a local term, a credential or a private path; move it to a profile" >&2
  exit 1
fi
[ -s "$terms" ] || echo "leak-guard: no local leak-terms.txt found; only credential shapes were checked" >&2
exit 0
