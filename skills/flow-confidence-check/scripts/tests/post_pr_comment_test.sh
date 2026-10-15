#!/usr/bin/env bash
set -eo pipefail
source "$(dirname "$0")/helpers.sh"

PC="$SCRIPTS_DIR/post-pr-comment.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cc-post-pr-comment.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Fake gh on PATH: logs every invocation, never talks to GitHub.
# GH_EXISTING_ID (when set) is what the comment-listing call returns, standing
# in for a flow-confidence-check comment already on the PR.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "repo view") echo "acme/widgets" ;;
  "pr view")   echo 42 ;;
  "api user")  echo "octocat" ;;
  "api repos/"*) [[ -n "$GH_EXISTING_ID" ]] && echo "$GH_EXISTING_ID" ;;
esac
exit 0
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"
export GH_LOG="$TMP/gh_log"
export GH_EXISTING_ID=""

reset_log() { : > "$GH_LOG"; }
log() { cat "$GH_LOG"; }

GOOD="$TMP/good.md"
cat > "$GOOD" <<'EOF'
<!-- flow-confidence-check
verdict: needs-review
sha: a1b2c3d4e5f6
findings: blocker=0 high=1 medium=0 low=0
low-budget: 2
ac: covered=1 partial=0 missing=0 out-of-reach=0
out-of-reach: -
spec: ABC-1234
spec-source: jira
execution: ci-green
verifier-model: model-b
context: clean
mode: full
blocked-by: 1 high finding
-->
## 🔎 flow-confidence-check - Verdict: NEEDS-REVIEW

**Summary for reviewers**
Adds the frobnicator.

**Criteria coverage**
- AC1 ✅

_Posted by flow-confidence-check on 2026-07-11 for commit a1b2c3d_
EOF

BAD="$TMP/bad.md"
cat > "$BAD" <<'EOF'
Great work, ship it! Verdict: high-confidence
EOF

# 1. no existing comment: posts a new one
reset_log
rc=0; bash "$PC" "$GOOD" >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "valid comment exits 0"
assert_contains "$(log)" "pr comment --body-file $GOOD" "posts a new comment"

# 2. --pr number is passed through
reset_log
bash "$PC" "$GOOD" --pr 123 >/dev/null 2>&1
assert_contains "$(log)" "pr comment 123 --body-file $GOOD" "gh called with PR number"
# and the PR number short-circuits the `gh pr view` lookup
[[ "$(log)" == *"pr view"* ]] && fail "explicit --pr must not call pr view" || PASS=$((PASS + 1))

# 3. existing comment: edits it in place, does NOT post a new one
reset_log
export GH_EXISTING_ID=987654
rc=0; bash "$PC" "$GOOD" >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "update path exits 0"
assert_contains "$(log)" \
  "api --method PATCH repos/acme/widgets/issues/comments/987654 -F body=@$GOOD" \
  "PATCHes the existing comment"
[[ "$(log)" == *"pr comment"* ]] && fail "must not also post a new comment" || PASS=$((PASS + 1))

# 4. the lookup filters on author and on the machine block opening the body
assert_contains "$(log)" 'select(.user.login == "octocat")' "lookup filters by author"
assert_contains "$(log)" 'startswith("<!-- flow-confidence-check")' "lookup filters by marker"

# 5. --new forces a fresh comment even when one exists
reset_log
bash "$PC" "$GOOD" --new >/dev/null 2>&1
assert_contains "$(log)" "pr comment --body-file $GOOD" "--new posts a new comment"
[[ "$(log)" == *"PATCH"* ]] && fail "--new must not PATCH" || PASS=$((PASS + 1))
export GH_EXISTING_ID=""

# 6. invalid comment: exit 1, missing markers named, gh NOT called at all
reset_log
rc=0; err="$(bash "$PC" "$BAD" 2>&1)" || rc=$?
assert_eq "1" "$rc" "invalid comment exits 1"
assert_contains "$err" "**Summary for reviewers**" "missing marker named"
assert_contains "$err" "refusing to post" "refusal message printed"
assert_eq "" "$(log)" "gh must not be called for an invalid comment"

# 7. missing file: exit 2
rc=0; bash "$PC" "$TMP/nope.md" >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "missing file exits 2"

# 8. out-of-reach AC with an owning ticket: posts
OOR="$TMP/oor.md"
sed -e 's/^ac: .*/ac: covered=1 partial=0 missing=0 out-of-reach=1/' \
    -e 's/^out-of-reach: .*/out-of-reach: AC4=ABC-227/' "$GOOD" > "$OOR"
reset_log
rc=0; bash "$PC" "$OOR" >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "out-of-reach AC with an owning ticket posts"

# 9. out-of-reach AC with no owning ticket: refused, gh not called
NOTICKET="$TMP/no-ticket.md"
sed -e 's/^ac: .*/ac: covered=1 partial=0 missing=0 out-of-reach=1/' \
    -e 's/^out-of-reach: .*/out-of-reach: AC4/' "$GOOD" > "$NOTICKET"
reset_log
rc=0; err="$(bash "$PC" "$NOTICKET" 2>&1)" || rc=$?
assert_eq "1" "$rc" "out-of-reach without a ticket exits 1"
assert_contains "$err" "names no owning ticket" "refusal names the missing ticket"
assert_eq "" "$(log)" "gh must not be called when out-of-reach has no ticket"

# 10. count and mapping line disagree: refused
MISMATCH="$TMP/mismatch.md"
sed -e 's/^ac: .*/ac: covered=1 partial=0 missing=0 out-of-reach=2/' \
    -e 's/^out-of-reach: .*/out-of-reach: AC4=ABC-227/' "$GOOD" > "$MISMATCH"
rc=0; err="$(bash "$PC" "$MISMATCH" 2>&1)" || rc=$?
assert_eq "1" "$rc" "out-of-reach count mismatch exits 1"
assert_contains "$err" "lists 1 ticket" "refusal names the mismatch"

# 11. pre-out-of-reach comment shape (no low-budget / out-of-reach fields): refused
OLD="$TMP/old-shape.md"
grep -v -e '^low-budget: ' -e '^out-of-reach: ' "$GOOD" > "$OLD"
rc=0; err="$(bash "$PC" "$OLD" 2>&1)" || rc=$?
assert_eq "1" "$rc" "comment missing the new machine-block fields exits 1"
assert_contains "$err" "low-budget: " "missing low-budget named"

# 12. high-confidence with execution proven at the head SHA: posts
HC_LOCAL="$TMP/hc-local.md"
sed -e 's/^verdict: .*/verdict: high-confidence/' \
    -e 's/^execution: .*/execution: local-verified/' "$GOOD" > "$HC_LOCAL"
reset_log
rc=0; bash "$PC" "$HC_LOCAL" >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "high-confidence with local-verified execution posts"

# 13. high-confidence with unproven execution: refused, gh not called
HC_UNPROVEN="$TMP/hc-unproven.md"
sed -e 's/^verdict: .*/verdict: high-confidence/' \
    -e 's/^execution: .*/execution: unproven (check "build" pending at a1b2c3d)/' "$GOOD" > "$HC_UNPROVEN"
reset_log
rc=0; err="$(bash "$PC" "$HC_UNPROVEN" 2>&1)" || rc=$?
assert_eq "1" "$rc" "high-confidence with unproven execution exits 1"
assert_contains "$err" "needs execution ci-green or local-verified" "refusal names the missing proof"
assert_eq "" "$(log)" "gh must not be called for unproven high-confidence"

# 14. needs-review with unproven execution: posts
NR_UNPROVEN="$TMP/nr-unproven.md"
sed -e 's/^execution: .*/execution: unproven (uncommitted fixes)/' "$GOOD" > "$NR_UNPROVEN"
rc=0; bash "$PC" "$NR_UNPROVEN" >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "needs-review with unproven execution posts"

# 15. legacy deferred-to-ci value: refused
LEGACY="$TMP/legacy-exec.md"
sed -e 's/^execution: .*/execution: deferred-to-ci/' "$GOOD" > "$LEGACY"
rc=0; err="$(bash "$PC" "$LEGACY" 2>&1)" || rc=$?
assert_eq "1" "$rc" "unknown execution value exits 1"
assert_contains "$err" "is not ci-green, local-verified or unproven" "refusal names the allowed values"

report
