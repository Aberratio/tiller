#!/usr/bin/env bash
# PreToolUse hook: deny a tool call that reaches a brain the session's project was not granted, or
# another project's profile. The project is resolved from the hook's cwd; grants come from
# brains/access.json through lib/resolve-brains.sh. Fails closed: when the input, the matrix or
# this script is broken, any call that names a protected root is denied and the rest allowed.

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../profile-name.sh
. "$LIB/profile-name.sh"
export TILLER_HOME="${TILLER_HOME:-$(dirname "$LIB")}"
input="$(cat)"

deny() {
  jq -cn --arg r "private-access: $1" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
  exit 0
}

# Any brains/<x> or profiles/<x> that is not a template, in free text.
names_protected() {
  printf '%s' "$1" | grep -Eq '(^|[^A-Za-z0-9_.-])(brains|profiles)/[A-Za-z0-9]'
}

# Absolute, symlinks resolved; a missing tail is kept as written under its nearest existing parent.
norm() {
  local p="$1" tail=""
  case "$p" in
    "~") p="$HOME" ;;
    "~/"*) p="$HOME/${p#\~/}" ;;
    /*) ;;
    *) p="$cwd/$p" ;;
  esac
  while [ ! -e "$p" ] && [ "$p" != / ]; do
    tail="/${p##*/}$tail"
    p="$(dirname "$p")"
  done
  p="$(realpath "$p")" || return 1
  printf '%s%s\n' "${p%/}" "$tail"
}

level_of() {
  printf '%s\n' "$grants" | awk -F'\t' -v b="$1" '$1 == b { print $2; f = 1 } END { if (!f) print "none" }'
}

# judge <absolute path> <1 when the tool writes>
judge() {
  local p="$1" w="$2" rest name lvl
  case "$p" in
    "$home/brains"|"$home/profiles") return 0 ;;
    "$home/brains/access.json")
      [ "$w" = 1 ] && deny "brains/access.json is written only through lib/brain-access.sh"
      return 0 ;;
    "$home/brains/_template"|"$home/brains/_template/"*|"$home/profiles/_template"|"$home/profiles/_template/"*) return 0 ;;
    "$home/brains/"*)
      rest="${p#"$home/brains/"}"; name="${rest%%/*}"
      [ "$rest" = "$name" ] && [ ! -d "$home/brains/$name" ] && return 0
      [ -n "$broken" ] && deny "brain \"$name\" denied: $broken"
      lvl="$(level_of "$name")"
      [ "$lvl" = none ] && deny "brain \"$name\" is \"none\" for profile \"$row\" (brains/access.json)"
      [ "$lvl" = read ] && [ "$w" = 1 ] && deny "brain \"$name\" is \"read\" for profile \"$row\" (brains/access.json)"
      return 0 ;;
    "$home/profiles/"*)
      rest="${p#"$home/profiles/"}"; name="${rest%%/*}"
      [ "$rest" = "$name" ] && [ ! -d "$home/profiles/$name" ] && return 0
      [ -n "$broken" ] && deny "profiles/$name denied: $broken"
      # A session outside any project may read, never write, every project's doubt log.
      if [ "$w" = 0 ] && [ "$row" = _none ]; then
        case "$rest" in "$name/doubts"|"$name/doubts/"*) return 0 ;; esac
      fi
      [ "$name" = "$row" ] || deny "profiles/$name is not the resolved profile \"$row\""
      return 0 ;;
  esac
  return 0
}

# judge_path <raw path> <1 when the tool writes>
judge_path() {
  local n
  if [ -z "$1" ]; then
    names_protected "$input" && deny "no path in the tool input"
    return 0
  fi
  n="$(norm "$1")" || deny "could not normalise $1"
  judge "$n" "$2"
}

# Glob: the search root joined with the pattern's literal prefix (segments before the first wildcard).
glob_target() {
  local base="$1" pattern="$2" prefix
  prefix="$(printf '%s' "$pattern" | awk -F/ '{ o = ""; for (i = 1; i <= NF; i++) { if ($i ~ /[*?[{]/) break; o = o (i > 1 ? "/" : "") $i } print o }')"
  case "$prefix" in
    "") printf '%s\n' "$base" ;;
    /*) printf '%s\n' "$prefix" ;;
    *) printf '%s\n' "$base/$prefix" ;;
  esac
}

f() { jq -r --arg k "$1" '.tool_input[$k] // empty' <<<"$input"; }

# word_hit <text> <relative path> -> the path appears as a whole path segment run.
word_hit() {
  local re
  re="$(printf '%s' "$2" | sed 's/[.[\*^$()+?{|]/\\&/g')"
  printf '%s' "$1" | grep -Eq "(^|[^A-Za-z0-9_.-])$re([^A-Za-z0-9_.-]|\$)"
}

# Write operators, after dropping redirections that only reach /dev/null or another descriptor.
writes() {
  printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*(&[0-9]+|\/dev\/null)//g' |
    grep -Eq '>|(^|[^A-Za-z0-9_-])(tee|mv|cp|rm|rmdir|touch|mkdir|ln|install|rsync|truncate|dd|chmod|chown|unlink|patch)([^A-Za-z0-9_-]|$)|(sed|perl)[^|;&]*[[:space:]]-i|git[^|;&]*[[:space:]](commit|add|mv|rm|checkout|reset|restore|stash|apply|am|merge|rebase|pull|clean)([^A-Za-z0-9_-]|$)'
}

# The command text names every path it reaches only when it is written out; see the spec's Known gap.
scan_bash() {
  local cmd="$1" b p lvl
  if [ -n "$broken" ]; then
    names_protected "$cmd" && deny "Bash names a protected path: $broken"
    return 0
  fi
  word_hit "$cmd" brains/access.json && writes "$cmd" && deny "brains/access.json is written only through lib/brain-access.sh"
  while IFS= read -r b; do
    [ -n "$b" ] && word_hit "$cmd" "brains/$b" || continue
    lvl="$(level_of "$b")"
    [ "$lvl" = none ] && deny "brain \"$b\" is \"none\" for profile \"$row\" (brains/access.json)"
    [ "$lvl" = read ] && writes "$cmd" && deny "brain \"$b\" is \"read\" for profile \"$row\" (brains/access.json)"
  done <<<"$(list_names "$home/brains")"
  local seen="$cmd"
  if [ "$row" = _none ] && ! writes "$cmd"; then
    seen="$(printf '%s' "$cmd" | sed -E 's#profiles/[A-Za-z0-9_-]+/doubts([^A-Za-z0-9_.-]|$)#\1#g')"
  fi
  while IFS= read -r p; do
    [ -n "$p" ] && [ "$p" != "$row" ] || continue
    word_hit "$seen" "profiles/$p" && deny "profiles/$p is not the resolved profile \"$row\""
  done <<<"$(list_names "$home/profiles" profile.md)"
  return 0
}

main() {
  local p
  tool="$(jq -r '.tool_name // empty' <<<"$input" 2>/dev/null)" || tool=""
  cwd="$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)" || cwd=""
  if [ -z "$tool" ] || [ -z "$cwd" ]; then
    names_protected "$input" && deny "malformed hook input"
    return 0
  fi
  home="$(realpath "$TILLER_HOME")" || { names_protected "$input" && deny "TILLER_HOME unreadable"; return 0; }

  broken=""
  if row="$(profile_name "$home/profiles" "$cwd")"; then
    [ -f "$home/profiles/$row/profile.md" ] || broken="profile \"$row\" is named but does not exist"
  else
    row=_none
  fi
  grants=""
  if [ -z "$broken" ]; then
    grants="$("$LIB/resolve-brains.sh" --row "$row" 2>/dev/null)" \
      || broken="brains/access.json is invalid (run lib/resolve-brains.sh)"
  fi

  case "$tool" in
    Read) judge_path "$(f file_path)" 0 ;;
    Edit|Write) judge_path "$(f file_path)" 1 ;;
    NotebookEdit) judge_path "$(f notebook_path)" 1 ;;
    Grep) p="$(f path)"; judge_path "${p:-$cwd}" 0 ;;
    Glob)
      p="$(f path)"; p="${p:-$cwd}"
      judge_path "$p" 0
      judge_path "$(glob_target "$(norm "$p")" "$(f pattern)")" 0 ;;
    Bash) scan_bash "$(f command)" ;;
  esac
  return 0
}

out="$(main)"; rc=$?
[ "$rc" -eq 0 ] && { printf '%s' "$out"; exit 0; }
names_protected "$input" && deny "internal error ($rc) while judging a protected path"
exit 0
