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
#   ./install.sh --setup-personal <owner>                     # generate personal skills, then link them
#   ./install.sh --agents                                     # write the harness roles to ~/.claude/agents
#
# --setup-personal asks for the person's details and renders every template in personal/_templates/
# into personal/<owner>/ (git-ignored), then links the result. Re-running reuses the stored answers
# and never overwrites a generated skill that was edited since (see personal/_templates/README.md).
#
# `all` never reaches personal/: one person's skills are installed only when asked for by owner.
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
REPO_DIR="$ROOT_DIR/skills"
CLAUDE_SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
CODEX_SKILLS_DIR="${CODEX_SKILLS_DIR:-$HOME/.agents/skills}"

usage() {
  echo "Usage: $0 [--target claude|codex|all] [--personal <owner>] all | <skill-name>…"
  echo "       $0 [--target claude|codex|all] --setup-personal <owner>"
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

# link_skill <skill-name> <target-dir>
link_skill() {
  local skill="$1" skills_dir="$2"
  local src="$REPO_DIR/$skill"
  local dest="$skills_dir/$skill"

  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    echo "ok:      $skill (already installed in $skills_dir)"
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "skipped: $skill ($dest already exists and is not a link to this repo)" >&2
  else
    ln -s "$src" "$dest"
    echo "linked:  $skill -> $dest"
  fi
}

target="claude"
personal=""
setup_personal=""

# Parse a leading --target/-t flag; the rest are the skill selector.
if [ "${1:-}" = "--agents" ]; then
  exec node "$ROOT_DIR/lib/agents/install-agents.mjs" ${CLAUDE_AGENTS_DIR:+--dir "$CLAUDE_AGENTS_DIR"}
fi

while [ $# -ge 1 ]; do
  case "$1" in
    --target=*) target="${1#*=}"; shift ;;
    --target|-t) target="${2:-}"; shift 2 ;;
    --personal=*) personal="${1#*=}"; shift ;;
    --personal|-p) personal="${2:-}"; shift 2 ;;
    --setup-personal=*) setup_personal="${1#*=}"; shift ;;
    --setup-personal) setup_personal="${2:-}"; shift 2 ;;
    *) break ;;
  esac
done

if [ -n "$setup_personal" ]; then
  if [ -n "$personal" ] && [ "$personal" != "$setup_personal" ]; then
    echo "error: --personal and --setup-personal name different owners" >&2
    exit 1
  fi
  # Exit 3 means some skills were kept because they were edited by hand; link them anyway.
  rc=0
  node "$ROOT_DIR/lib/personal/generate.mjs" --user "$setup_personal" --all || rc=$?
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

echo
echo "Restart the affected tool (or start a new session) to pick up new skills."
