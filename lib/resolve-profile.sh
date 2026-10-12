#!/usr/bin/env bash
# Resolve the project profile for a working directory.
#
#   resolve-profile.sh [dir]        -> prints the profile file path, or fails
#
# Order: TILLER_PROFILE env > .tiller-profile at the repo root > repo_globs match > fail.
# Failing is the point: a skill that cannot tell one project's profile from another must stop, not guess.
# TILLER_PROFILES_DIR replaces the profiles directory, for tests.
#
# TILLER_OVERLAY=<env> layers profiles/<name>/overlays/<env>.md over the profile: each of its sections
# replaces the profile's section of the same heading whole, or is appended. Text before its first
# section is ignored. The merged file is written next to the profile and its path printed instead.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES="${TILLER_PROFILES_DIR:-$REPO_DIR/profiles}"
target="$(cd "${1:-$PWD}" 2>/dev/null && pwd)" || { echo "resolve-profile: no such dir" >&2; exit 2; }

# Sections that carry the owner's authority: an environment must not loosen them.
PROTECTED='merge authority|inviolables|owner proxy'

emit() {
  [ -f "$PROFILES/$1/profile.md" ] || { echo "resolve-profile: no profile '$1'" >&2; exit 3; }
  [ -z "${TILLER_OVERLAY:-}" ] && { echo "$PROFILES/$1/profile.md"; exit 0; }
  printf '%s' "$TILLER_OVERLAY" | grep -Eq '^[a-z0-9][a-z0-9-]*$' \
    || { echo "resolve-profile: overlay name '$TILLER_OVERLAY' is not [a-z0-9-]" >&2; exit 3; }
  local base="$PROFILES/$1/profile.md" over="$PROFILES/$1/overlays/$TILLER_OVERLAY.md"
  local out="$PROFILES/$1/.merged-$TILLER_OVERLAY.md"
  [ -f "$over" ] || { echo "resolve-profile: no overlay '$TILLER_OVERLAY' for profile '$1'" >&2; exit 3; }
  local bad
  bad="$(grep -E "^## ($PROTECTED)\$" "$over" | sed 's/^## //' | paste -sd, -)"
  [ -z "$bad" ] || { echo "resolve-profile: overlay '$TILLER_OVERLAY' may not set: $bad" >&2; exit 3; }
  awk '
    FNR == 1 { file++ }
    file == 1 && /^## / { h = $0; order[++n] = h; seen[h] = 1 }
    file == 1 && h != "" { body[h] = body[h] $0 "\n"; next }
    file == 1 { next }
    /^## / { skip = ($0 in seen); if (skip) { printf "%s", body[$0]; done[$0] = 1 } }
    !skip { print }
    END { for (i = 1; i <= n; i++) if (!(order[i] in done)) { print ""; printf "%s", body[order[i]] } }
  ' "$over" "$base" >"$out.tmp" && mv "$out.tmp" "$out" \
    || { echo "resolve-profile: could not write $out" >&2; exit 3; }
  echo "$out"
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
