#!/usr/bin/env bash
# Symlink skills from tiller into a tool's skill directory.
#
# Skills live in skills/; profiles and lib/ stay in the repo and are read at runtime, so the
# skills directory is the only thing that gets linked out.
#
# Usage:
#   ./install.sh [--target claude|codex|all] all              # install every skill
#   ./install.sh [--target claude|codex|all] <skill-name>…    # install specific skills
#   ./install.sh --personal <owner> all | <skill-name>…       # install from personal/<owner>/skills
#   ./install.sh --setup-personal <owner> [--answers <f.json>] # generate personal skills, then link them
#   ./install.sh --profile <name> all | <skill-name>…         # install from profiles/<name>/skills
#   ./install.sh --agents [--profile <profile.md>]            # write the harness roles to ~/.claude/agents
#   ./install.sh --hooks                                      # print the settings.json fragment for the private-access hook
#   ./install.sh --helm <git-url>                             # clone the private helm into helm/
#   ./install.sh --helm --new <git-url>                       # create a helm from lib/helm/template and push it
#   ./install.sh --prereqs [--yes]                            # install the missing prerequisites for this OS
#
# Every other form first checks the prerequisites (node, git, bash, jq; gh and claude optional) with
# lib/setup/prereqs.sh and refuses when a required one is missing, naming the --prereqs command that
# installs it through the platform's package manager (brew, apt, dnf, apk, pacman, winget).
# TILLER_SKIP_PREREQS=1 skips that check. On Windows this script runs in Git Bash; install.ps1
# bootstraps Git Bash itself and then calls it.
#
# --setup-personal asks for the person's details and renders every template in personal/_templates/
# into personal/<owner>/ (git-ignored), then links the result. Re-running reuses the stored answers
# and never overwrites a generated skill that was edited since (see personal/_templates/README.md).
#
# `all` never reaches personal/ or profiles/: one person's or one project's skills are installed
# only when asked for by owner or profile name. `--profile <name> all` also links the profile's
# agents/*.md into ~/.claude/agents (override: CLAUDE_AGENTS_DIR).
#
# --target selects which tool(s) to install for (default: claude):
#   claude   ~/.claude/skills   (override: CLAUDE_SKILLS_DIR)
#   codex    ~/.agents/skills   (override: CODEX_SKILLS_DIR)
#   all      every supported tool above
#
# Idempotent: re-running never overwrites; skills already linked to this repo
# are left untouched.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The same path as Windows programs see it (C:/...), which is also what Node and settings.json
# need there; everywhere else it is ROOT_DIR. `pwd -W` exists only in Git Bash.
ROOT_DIR_NATIVE="$(cd "$ROOT_DIR" && (pwd -W 2>/dev/null || pwd))"
REPO_DIR="$ROOT_DIR/skills"
PREREQS="$ROOT_DIR/lib/setup/prereqs.sh"
OS="$(bash "$PREREQS" os)"
# Git Bash copies on `ln -s` unless native links are requested; Windows allows them in Developer Mode.
[ "$OS" = windows ] && export MSYS=winsymlinks:nativestrict
CLAUDE_SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
CODEX_SKILLS_DIR="${CODEX_SKILLS_DIR:-$HOME/.agents/skills}"

usage() {
  echo "Usage: $0 [--target claude|codex|all] [--personal <owner>] all | <skill-name>…"
  echo "       $0 [--target claude|codex|all] --setup-personal <owner> [--answers <file.json>]"
  echo "       $0 [--target claude|codex|all] --profile <name> all | <skill-name>…"
  echo
  echo "Targets (default: claude):"
  echo "  claude   $CLAUDE_SKILLS_DIR"
  echo "  codex    $CODEX_SKILLS_DIR"
  echo "  all      every supported tool above"
  echo
  echo "Available skills:"
  for dir in "$REPO_DIR"/*/; do
    [ -f "$dir/SKILL.md" ] && echo "  $(basename "$dir")"
  done
  exit 1
}

# link_skill <skill-name> <target-dir> [<source-dir>]
link_skill() {
  local skill="$1" skills_dir="$2"
  local src="${3:-$REPO_DIR}/$skill"
  local dest="$skills_dir/$skill"

  if same_target "$dest" "$src"; then
    echo "ok:      $skill (already installed in $skills_dir)"
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "skipped: $skill ($dest already exists and is not a link to this repo)" >&2
  else
    link "$src" "$dest"
    echo "linked:  $skill -> $dest"
  fi
}

# same_target <dest> <src>: <dest> already points at <src>. Compared through realpath because a
# link made on Windows reads back in a different spelling of the same path.
same_target() {
  [ -L "$1" ] || [ -d "$1" ] || return 1
  [ "$(readlink "$1" 2>/dev/null)" = "$2" ] && return 0
  [ -L "$1" ] || [ "$OS" = windows ] || return 1
  [ "$(realpath "$1" 2>/dev/null)" = "$(realpath "$2" 2>/dev/null)" ]
}

# link <src> <dest>: a symlink; on Windows, when native links are not allowed, a junction for a
# directory and a hard link for a file, both of which need no privilege.
link() {
  ln -s "$1" "$2" 2>/dev/null && return 0
  [ "$OS" = windows ] || { ln -s "$1" "$2"; return; }
  # MSYS rewrites arguments that look like POSIX paths (/J becomes C:/.../J); both variables stop
  # that for this one command, on Git for Windows and on plain MSYS2.
  local kind=/H
  [ -d "$1" ] && kind=/J
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' cmd /c mklink "$kind" "$(cygpath -w "$2")" "$(cygpath -w "$1")" >/dev/null
}

target="claude"
personal=""
setup_personal=""
profile=""
answers=""

if [ "${1:-}" = "--prereqs" ]; then
  exec bash "$PREREQS" install "${@:2}"
fi

# Preflight: refuse before anything is linked when a required tool is missing. Quiet when all is well.
if [ "${TILLER_SKIP_PREREQS:-0}" != 1 ]; then
  report="$(bash "$PREREQS" check)" || {
    echo "$report" >&2
    echo >&2
    bash "$PREREQS" plan >&2 || true
    echo "install.sh: a required tool is missing; run  ./install.sh --prereqs  to install the lines above, then rerun." >&2
    exit 2
  }
  echo "$report" | grep '^warn' >&2 || true
fi

# Parse a leading --target/-t flag; the rest are the skill selector.
if [ "${1:-}" = "--agents" ]; then
  exec node "$ROOT_DIR/lib/agents/install-agents.mjs" ${CLAUDE_AGENTS_DIR:+--dir "$CLAUDE_AGENTS_DIR"} "${@:2}"
fi

if [ "${1:-}" = "--helm" ]; then
  shift
  TILLER_HOME="$ROOT_DIR" exec node "$ROOT_DIR/lib/helm/helm.mjs" init "$@"
fi

if [ "${1:-}" = "--hooks" ]; then
  # Printed, never written: ~/.claude/settings.json is merged by hand, then the session restarted.
  jq -n \
    --arg cmd "TILLER_HOME=$(printf '%q' "$ROOT_DIR_NATIVE") $(printf '%q' "$ROOT_DIR_NATIVE/lib/hooks/private-access.sh")" \
    --arg session "TILLER_HOME=$(printf '%q' "$ROOT_DIR_NATIVE") $(printf '%q' "$ROOT_DIR_NATIVE/lib/hooks/helm-session.sh")" \
    '{hooks: {
      PreToolUse: [{matcher: "Read|Grep|Glob|Edit|Write|NotebookEdit|Bash", hooks: [{type: "command", command: $cmd}]}],
      SessionStart: [{hooks: [{type: "command", command: $session}]}]
    }}'
  echo "Merge into ~/.claude/settings.json, then restart the session." >&2
  exit 0
fi

while [ $# -ge 1 ]; do
  case "$1" in
    --target=*) target="${1#*=}"; shift ;;
    --target|-t) target="${2:-}"; shift 2 ;;
    --personal=*) personal="${1#*=}"; shift ;;
    --personal|-p) personal="${2:-}"; shift 2 ;;
    --setup-personal=*) setup_personal="${1#*=}"; shift ;;
    --setup-personal) setup_personal="${2:-}"; shift 2 ;;
    --profile=*) profile="${1#*=}"; shift ;;
    --profile) profile="${2:-}"; shift 2 ;;
    --answers=*) answers="${1#*=}"; shift ;;
    --answers) answers="${2:-}"; shift 2 ;;
    *) break ;;
  esac
done

if [ -n "$profile" ] && { [ -n "$personal" ] || [ -n "$setup_personal" ]; }; then
  echo "error: --profile cannot be combined with --personal or --setup-personal" >&2
  exit 1
fi
if [ -n "$answers" ] && [ -z "$setup_personal" ]; then
  echo "error: --answers only applies to --setup-personal" >&2
  exit 1
fi

if [ -n "$setup_personal" ]; then
  if [ -n "$personal" ] && [ "$personal" != "$setup_personal" ]; then
    echo "error: --personal and --setup-personal name different owners" >&2
    exit 1
  fi
  # Exit 3 means some skills were kept because they were edited by hand; link them anyway.
  rc=0
  gen_args=(--user "$setup_personal" --all)
  [ -n "$answers" ] && gen_args+=(--answers "$answers" --non-interactive)
  node "$ROOT_DIR/lib/personal/generate.mjs" "${gen_args[@]}" || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ]; then
    echo "error: generating personal skills for '$setup_personal' failed" >&2
    exit "$rc"
  fi
  personal="$setup_personal"
  set -- all
fi

if [ -n "$personal" ]; then
  REPO_DIR="${TILLER_PERSONAL_ROOT:-$ROOT_DIR/personal}/$personal/skills"
  if [ ! -d "$REPO_DIR" ]; then
    echo "error: no personal skills for '$personal' (no $REPO_DIR)" >&2
    exit 1
  fi
fi

if [ -n "$profile" ]; then
  PROFILE_DIR="${TILLER_PROFILES_ROOT:-$ROOT_DIR/profiles}/$profile"
  REPO_DIR="$PROFILE_DIR/skills"
  if [ ! -d "$REPO_DIR" ]; then
    echo "error: no skills in profile '$profile' (no $REPO_DIR)" >&2
    exit 1
  fi
fi

case "$target" in
  claude) target_dirs=("$CLAUDE_SKILLS_DIR") ;;
  codex)  target_dirs=("$CODEX_SKILLS_DIR") ;;
  all)    target_dirs=("$CLAUDE_SKILLS_DIR" "$CODEX_SKILLS_DIR") ;;
  *) echo "error: unknown target '$target' (expected claude|codex|all)" >&2; usage ;;
esac

[ $# -ge 1 ] || usage

if [ "$1" = "all" ]; then
  skills=()
  for dir in "$REPO_DIR"/*/; do
    [ -f "$dir/SKILL.md" ] && skills+=("$(basename "$dir")")
  done
else
  skills=("$@")
fi

for skill in "${skills[@]}"; do
  if [ ! -f "$REPO_DIR/$skill/SKILL.md" ]; then
    echo "error: '$skill' is not a skill in this repo (no $skill/SKILL.md)" >&2
    usage
  fi
done

for skills_dir in "${target_dirs[@]}"; do
  mkdir -p "$skills_dir"
  for skill in "${skills[@]}"; do
    link_skill "$skill" "$skills_dir"
  done
done

# A profile's agents are linked on `all` only; they belong to the profile like its skills do.
if [ -n "$profile" ] && [ "$1" = "all" ] && [ -d "$PROFILE_DIR/agents" ]; then
  agents_dir="${CLAUDE_AGENTS_DIR:-$HOME/.claude/agents}"
  mkdir -p "$agents_dir"
  for f in "$PROFILE_DIR/agents"/*.md; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    if [ -L "$agents_dir/$name" ] && [ "$(readlink "$agents_dir/$name")" = "$f" ]; then
      echo "ok:      agent $name (already linked)"
    elif [ -e "$agents_dir/$name" ] || [ -L "$agents_dir/$name" ]; then
      echo "skipped: agent $name ($agents_dir/$name already exists and is not a link to this profile)" >&2
    else
      ln -s "$f" "$agents_dir/$name"
      echo "linked:  agent $name -> $agents_dir/$name"
    fi
  done
fi

echo
echo "Restart the affected tool (or start a new session) to pick up new skills."
