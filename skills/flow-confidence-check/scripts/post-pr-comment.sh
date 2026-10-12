#!/usr/bin/env bash
# Template gate for the flow-confidence-check PR comment.
# Refuses to post unless the comment matches the PR-comment skeleton in
# references/report-template.md, then posts it via `gh`.
#
# When this skill already has a comment on the PR it is EDITED in place, so a
# PR carries exactly one flow-confidence-check machine block and automation can
# never read a stale verdict. `--new` forces a fresh comment instead.
# Never touches the PR description.
set -eo pipefail

MARKER="<!-- flow-confidence-check"

usage() {
  echo "Usage: post-pr-comment.sh <comment-file.md> [--pr <number>] [--new]" >&2
  exit 2
}

FILE=""
PR=""
FORCE_NEW=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)      PR="$2"; shift 2 ;;
    --new)     FORCE_NEW=1; shift ;;
    -h|--help) usage ;;
    -*)        echo "unknown option: $1" >&2; usage ;;
    *)         [[ -n "$FILE" ]] && usage; FILE="$1"; shift ;;
  esac
done

[[ -n "$FILE" ]] || usage
[[ -f "$FILE" ]] || { echo "comment file not found: $FILE" >&2; exit 2; }

MARKERS=(
  "$MARKER"
  "verdict: "
  "sha: "
  "low-budget: "
  "out-of-reach: "
  "## 🔎 flow-confidence-check - Verdict:"
  "**Summary for reviewers**"
  "**Criteria coverage**"
  "_Posted by flow-confidence-check"
)

MISSING=0
for m in "${MARKERS[@]}"; do
  if ! grep -qF -- "$m" "$FILE"; then
    echo "missing required section: $m" >&2
    MISSING=1
  fi
done
if [[ "$MISSING" -eq 1 ]]; then
  echo "refusing to post: comment does not match the PR-comment skeleton in references/report-template.md" >&2
  exit 1
fi

# out-of-reach consistency. An `out-of-reach` AC is only legal with an owning ticket
# (SKILL.md Phase 3, requirement O1); one without a ticket is a criterion retired by
# assertion, so refuse to publish it rather than let the PR carry it.
OOR_COUNT="$(sed -n 's/^ac: .*out-of-reach=\([0-9][0-9]*\).*/\1/p' "$FILE" | head -1)"
OOR_LINE="$(sed -n 's/^out-of-reach: //p' "$FILE" | head -1)"
if [[ -z "$OOR_COUNT" ]]; then
  echo "refusing to post: the 'ac:' line must carry out-of-reach=<n>" >&2
  exit 1
fi
OOR_ENTRIES=0
if [[ "$OOR_LINE" != "-" ]]; then
  IFS=',' read -ra _oor <<< "$OOR_LINE"
  for e in "${_oor[@]}"; do
    e="${e#"${e%%[![:space:]]*}"}"; e="${e%"${e##*[![:space:]]}"}"
    [[ -z "$e" ]] && continue
    if [[ ! "$e" =~ ^AC[0-9]+=([A-Z][A-Z0-9]*-[0-9]+|#[0-9]+)$ ]]; then
      echo "refusing to post: out-of-reach entry '$e' names no owning ticket (expected AC<n>=<TICKET>)" >&2
      exit 1
    fi
    OOR_ENTRIES=$((OOR_ENTRIES + 1))
  done
fi
if [[ "$OOR_COUNT" -ne "$OOR_ENTRIES" ]]; then
  echo "refusing to post: ac: out-of-reach=$OOR_COUNT but the out-of-reach line lists $OOR_ENTRIES ticket(s)" >&2
  exit 1
fi

# Id of this skill's newest existing comment on the PR, or empty. Matched on
# author + the machine block opening the body, so a human quoting the marker
# inside their own comment is never mistaken for ours. Any failure here (no
# repo, no PR yet, offline) falls through to posting a new comment.
existing_comment_id() {
  local repo login
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || return 0
  [[ -n "$repo" ]] || return 0
  if [[ -z "$PR" ]]; then
    PR="$(gh pr view --json number -q .number 2>/dev/null)" || return 0
  fi
  [[ -n "$PR" ]] || return 0
  login="$(gh api user -q .login 2>/dev/null)" || return 0
  [[ -n "$login" ]] || return 0

  gh api "repos/$repo/issues/$PR/comments" --paginate \
    -q ".[] | select(.user.login == \"$login\") | select(.body | startswith(\"$MARKER\")) | .id" \
    2>/dev/null | tail -1
}

if [[ "$FORCE_NEW" -eq 0 ]]; then
  ID="$(existing_comment_id)" || ID=""
  if [[ -n "$ID" ]]; then
    REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
    echo "updating existing flow-confidence-check comment $ID" >&2
    exec gh api --method PATCH "repos/$REPO/issues/comments/$ID" -F "body=@$FILE"
  fi
fi

if [[ -n "$PR" ]]; then
  exec gh pr comment "$PR" --body-file "$FILE"
else
  exec gh pr comment --body-file "$FILE"
fi
