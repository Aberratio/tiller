# Sourced, not run. Profile lookup shared by resolve-profile.sh, resolve-brains.sh and the
# private-access hook, so the three never disagree on which project a directory belongs to.

# profile_name <profiles-dir> <dir> -> the profile name; returns 1 when nothing names one.
# Order: TILLER_PROFILE env > .tiller-profile at the repo root > repo_globs, longest first, so a
# worktree path never loses to the shorter glob of its parent workspace. A name starting with _ is
# a template. Whether the named profile exists is the caller's check.
profile_name() {
  local profiles="$1" target="$2" root p name glob line
  local entries=()
  if [ -n "${TILLER_PROFILE:-}" ]; then printf '%s\n' "$TILLER_PROFILE"; return 0; fi
  root="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null || echo "$target")"
  if [ -f "$root/.tiller-profile" ]; then
    head -1 "$root/.tiller-profile" | tr -d '[:space:]'; echo; return 0
  fi
  for p in "$profiles"/*/profile.md; do
    [ -f "$p" ] || continue
    name="$(basename "$(dirname "$p")")"
    case "$name" in _*) continue ;; esac
    while IFS= read -r glob; do
      [ -n "$glob" ] && entries+=("${#glob} $glob $name")
    done < <(awk '/^repo_globs:/{f=1;next} /^[a-z_]+:/{f=0} f&&/^ *- /{sub(/^ *- */,"");gsub(/"/,"");print}' "$p")
  done
  [ "${#entries[@]}" -gt 0 ] || return 1
  while IFS= read -r line; do
    glob="${line#* }"; glob="${glob% *}"
    name="${line##* }"
    # shellcheck disable=SC2254
    case "$target" in $glob|$glob/*) printf '%s\n' "$name"; return 0 ;; esac
  done < <(printf '%s\n' "${entries[@]}" | sort -rn)
  return 1
}

# list_names <dir> [<required-file>] -> names of its subdirectories (with that file, if given),
# templates (_*) skipped, one per line, sorted.
list_names() {
  local d n
  for d in "$1"/*/; do
    [ -d "$d" ] || continue
    n="${d%/}"; n="${n##*/}"
    case "$n" in _*) continue ;; esac
    [ -z "${2:-}" ] || [ -f "$1/$n/$2" ] || continue
    printf '%s\n' "$n"
  done
}
