#!/usr/bin/env bash
# Deterministic diff scope for flow-confidence-check.
# Prints the files changed on the current branch relative to the merge base
# with --base (default main), or their mapped test files with --mode tests,
# then optionally runs a command on them.
# bash 3.2 compatible; no `set -u` (empty-array expansion breaks under it).
set -eo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: changed-files.sh [options] [explicit-file ...] [-- <cmd> {}]

Options:
  --base <branch>      Base branch to diff against (default: main).
                       Uses origin/<branch> when it exists, else <branch>.
  --mode files|tests   files (default): changed files, deletions excluded.
                       tests: changed files mapped to existing test files.
  --filter <glob>      Keep only files matching the glob (e.g. '*.rb').
  --exclude <glob>     Drop files matching the glob. Repeatable.

Explicit positional files skip the diff and test mapping entirely
(filter/exclude still apply).
With `-- <cmd> {}`, every literal `{}` argument is replaced by the file
list and the command is executed; its exit code is propagated.
Without a command, the file list is printed one per line on stdout.
The merge-base SHA is printed on stderr as `merge-base: <sha>`.
EOF
  exit 2
}

BASE="main"
MODE="files"
FILTER=""
EXCLUDES=()
EXPLICIT=()
CMD=()
HAVE_CMD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)    BASE="$2"; shift 2 ;;
    --mode)    MODE="$2"; shift 2 ;;
    --filter)  FILTER="$2"; shift 2 ;;
    --exclude) EXCLUDES+=("$2"); shift 2 ;;
    -h|--help) usage ;;
    --)        shift; CMD=("$@"); HAVE_CMD=1; break ;;
    -*)        echo "unknown option: $1" >&2; usage ;;
    *)         EXPLICIT+=("$1"); shift ;;
  esac
done

case "$MODE" in
  files|tests) ;;
  *) echo "invalid --mode: $MODE (files|tests)" >&2; exit 2 ;;
esac

# map_to_tests <file>: print candidate test paths for a source file, one per
# line. Already-a-test files map to themselves. Callers keep only candidates
# that exist on disk.
map_to_tests() {
  local f="$1" stem dir base ext
  case "$f" in
    *_spec.rb|*_test.rb|*_test.go|*_test.py|test_*.py|*/test_*.py|\
    *.test.js|*.test.jsx|*.test.ts|*.test.tsx|\
    *.spec.js|*.spec.jsx|*.spec.ts|*.spec.tsx)
      printf '%s\n' "$f"; return ;;
  esac
  case "$f" in
    app/*.rb)
      stem="${f#app/}"; stem="${stem%.rb}"
      printf 'spec/%s_spec.rb\ntest/%s_test.rb\n' "$stem" "$stem" ;;
    lib/*.rb)
      stem="${f#lib/}"; stem="${stem%.rb}"
      printf 'spec/lib/%s_spec.rb\ntest/lib/%s_test.rb\n' "$stem" "$stem" ;;
    *.go)
      printf '%s\n' "${f%.go}_test.go" ;;
    *.py)
      base="$(basename "$f" .py)"
      printf 'tests/test_%s.py\ntest/test_%s.py\n' "$base" "$base" ;;
    *.js|*.jsx|*.ts|*.tsx)
      dir="$(dirname "$f")"; base="$(basename "$f")"
      ext="${base##*.}"; stem="${base%.*}"
      printf '%s/%s.test.%s\n%s/%s.spec.%s\n%s/__tests__/%s.test.%s\n' \
        "$dir" "$stem" "$ext" "$dir" "$stem" "$ext" "$dir" "$stem" "$ext" ;;
  esac
}

FILES=()
if [[ ${#EXPLICIT[@]} -gt 0 ]]; then
  FILES=("${EXPLICIT[@]}")
else
  if git rev-parse --verify --quiet "origin/$BASE" >/dev/null; then
    BASE_REF="origin/$BASE"
  else
    BASE_REF="$BASE"
  fi
  MERGE_BASE="$(git merge-base "$BASE_REF" HEAD)"
  echo "merge-base: $MERGE_BASE" >&2

  while IFS= read -r f; do
    [[ -n "$f" ]] && FILES+=("$f")
  done < <(
    {
      git diff --name-only --diff-filter=d "$MERGE_BASE" HEAD
      git diff --name-only --diff-filter=d HEAD
      git ls-files --others --exclude-standard
    } | sort -u
  )

  if [[ "$MODE" == "tests" ]]; then
    MAPPED=()
    for f in ${FILES[@]+"${FILES[@]}"}; do
      while IFS= read -r t; do
        [[ -n "$t" && -f "$t" ]] && MAPPED+=("$t")
      done < <(map_to_tests "$f")
    done
    FILES=()
    if [[ ${#MAPPED[@]} -gt 0 ]]; then
      while IFS= read -r f; do
        [[ -n "$f" ]] && FILES+=("$f")
      done < <(printf '%s\n' "${MAPPED[@]}" | sort -u)
    fi
  fi
fi

KEPT=()
for f in ${FILES[@]+"${FILES[@]}"}; do
  if [[ -n "$FILTER" ]]; then
    case "$f" in
      $FILTER) ;;
      *) continue ;;
    esac
  fi
  skip=0
  for g in ${EXCLUDES[@]+"${EXCLUDES[@]}"}; do
    case "$f" in
      $g) skip=1; break ;;
    esac
  done
  [[ "$skip" -eq 1 ]] && continue
  KEPT+=("$f")
done
FILES=(${KEPT[@]+"${KEPT[@]}"})

if [[ "$HAVE_CMD" -eq 0 ]]; then
  if [[ ${#FILES[@]} -gt 0 ]]; then
    printf '%s\n' "${FILES[@]}"
  fi
  exit 0
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "nothing to run: no files matched" >&2
  exit 0
fi

RUN=()
for w in "${CMD[@]}"; do
  if [[ "$w" == "{}" ]]; then
    RUN+=("${FILES[@]}")
  else
    RUN+=("$w")
  fi
done
exec "${RUN[@]}"
