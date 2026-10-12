#!/usr/bin/env bash
# Resolve the project profile for a working directory.
#
#   resolve-profile.sh [dir]        -> prints the profile file path, or fails
#
# Order: TILLER_PROFILE env > .tiller-profile at the repo root > repo_globs match > fail.
# Failing is the point: a skill that cannot tell one project's profile from another must stop, not guess.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES="$REPO_DIR/profiles"
target="$(cd "${1:-$PWD}" 2>/dev/null && pwd)" || { echo "resolve-profile: no such dir" >&2; exit 2; }

emit() {
  [ -f "$PROFILES/$1/profile.md" ] || { echo "resolve-profile: no profile '$1'" >&2; exit 3; }
  echo "$PROFILES/$1/profile.md"
  exit 0
}

# 1 — explicit override
[ -n "${TILLER_PROFILE:-}" ] && emit "$TILLER_PROFILE"

# 2 — marker file at the repo root
root="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null || echo "$target")"
[ -f "$root/.tiller-profile" ] && emit "$(head -1 "$root/.tiller-profile" | tr -d '[:space:]')"

# 3 — repo_globs of profiles/<name>/profile.md (a name starting with _ is a template). Every
#     profile's globs are collected first, then matched longest-first, so a
#     worktree path never loses to the shorter glob of its parent workspace.
entries=()
for p in "$PROFILES"/*/profile.md; do
  [ -f "$p" ] || continue
  name="$(basename "$(dirname "$p")")"
  case "$name" in _*) continue ;; esac
  while IFS= read -r glob; do
    [ -n "$glob" ] && entries+=("${#glob} $glob $name")
  done < <(awk '/^repo_globs:/{f=1;next} /^[a-z_]+:/{f=0} f&&/^ *- /{sub(/^ *- */,"");gsub(/"/,"");print}' "$p")
done

while IFS= read -r line; do
  glob="${line#* }"; glob="${glob% *}"
  name="${line##* }"
  # shellcheck disable=SC2254
  case "$target" in $glob|$glob/*) emit "$name" ;; esac
done < <(printf '%s\n' "${entries[@]}" | sort -rn)

echo "resolve-profile: no profile matches $target" >&2
echo "  set TILLER_PROFILE, or add a .tiller-profile file, or add a repo_glob to a profile" >&2
exit 1
