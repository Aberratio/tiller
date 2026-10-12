#!/usr/bin/env bash
# Content fingerprint of a file set, for flow-confidence-check's no-op fast path.
#
# With no arguments it fingerprints the branch's review scope by delegating to
# changed-files.sh (same base, same exclusions, same tracked + untracked-not-
# ignored semantics). With explicit paths it fingerprints exactly those files -
# used to fingerprint the skill's own SKILL.md + references.
#
# The hash covers both the sorted path list and every file's content, so an
# added, removed, renamed, or edited file all change it. It deliberately does
# NOT cover the merge base or the head SHA: committing an unchanged tree leaves
# the fingerprint identical, which is what lets a re-run re-stamp the SHA
# without re-reviewing anything.
#
# bash 3.2 compatible; no `set -u` (empty-array expansion breaks under it).
set -eo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: tree-hash.sh [changed-files.sh options] [explicit-file ...]

Prints a single sha256 hex digest on stdout.
All options and positional files are passed through to changed-files.sh,
so --base, --filter and --exclude behave identically there.
An empty file set hashes to the digest of the empty string.
EOF
  exit 2
}

case "$1" in
  -h|--help) usage ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

FILES=()
while IFS= read -r f; do
  [[ -n "$f" ]] && FILES+=("$f")
done < <("$HERE/changed-files.sh" "$@" 2>/dev/null)

# `<path> <content-digest>` per file, path-sorted, then digested as a whole.
{
  for f in ${FILES[@]+"${FILES[@]}"}; do
    if [[ -f "$f" ]]; then
      printf '%s %s\n' "$f" "$(sha256 < "$f")"
    else
      printf '%s missing\n' "$f"
    fi
  done
} | LC_ALL=C sort | sha256
