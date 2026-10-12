#!/usr/bin/env bash
set -eo pipefail
source "$(dirname "$0")/helpers.sh"

TH="$SCRIPTS_DIR/tree-hash.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repo"
mkdir -p "$REPO"
make_fixture_repo "$REPO"
cd "$REPO"

hash_of() { bash "$TH" "$@"; }

BASE="$(hash_of)"

# 1. deterministic: same tree hashes the same
assert_eq "$BASE" "$(hash_of)" "hash is stable across runs"

# 2. looks like a sha256 digest
if [[ "$BASE" =~ ^[0-9a-f]{64}$ ]]; then
  PASS=$((PASS + 1))
else
  fail "expected a 64-char hex digest, got: $BASE"
fi

# 3. editing a tracked, already-changed file changes the hash
echo more >> app/services/foo.rb
EDITED="$(hash_of)"
[[ "$EDITED" != "$BASE" ]] && PASS=$((PASS + 1)) || fail "edit must change the hash"

# 4. restoring the content restores the hash (content-addressed, not time)
printf 'foo\nunstaged\n' > app/services/foo.rb
assert_eq "$BASE" "$(hash_of)" "restoring content restores the hash"

# 5. committing an unchanged tree does NOT change the hash - this is the whole
#    point of the no-op fast path: the engineer commits the auto-fixes and the
#    verdict only needs a new SHA stamp, not a new review.
git add -A
git commit -qm "commit the working tree"
assert_eq "$BASE" "$(hash_of)" "committing identical content keeps the hash"

# 6. an untracked-not-ignored file counts (it is in review scope)
echo scratch > app/scratch.rb
UNTRACKED="$(hash_of)"
[[ "$UNTRACKED" != "$BASE" ]] && PASS=$((PASS + 1)) || fail "untracked file must change the hash"

# 7. a gitignored file does NOT count
rm app/scratch.rb
echo 'ignored.rb' > .gitignore
git add .gitignore && git commit -qm gitignore
WITH_IGNORE="$(hash_of)"
echo secret > ignored.rb
assert_eq "$WITH_IGNORE" "$(hash_of)" "gitignored file is outside the hash"

# 8. --exclude drops files from the hash
rm ignored.rb
assert_eq "$WITH_IGNORE" "$(hash_of)" "cleanup restores the hash"
EXCLUDED="$(hash_of --exclude 'db/*')"
[[ "$EXCLUDED" != "$WITH_IGNORE" ]] && PASS=$((PASS + 1)) || fail "--exclude must change the hash"

# 9. explicit paths hash only those paths (used for the skill's own files)
E1="$(hash_of app/services/foo.rb)"
E2="$(hash_of app/services/foo.rb)"
assert_eq "$E1" "$E2" "explicit-path hash is stable"
[[ "$E1" != "$WITH_IGNORE" ]] && PASS=$((PASS + 1)) || fail "explicit paths must hash differently from full scope"

# 10. deleting a reviewed file changes the hash
rm app/services/foo.rb
DELETED="$(hash_of)"
[[ "$DELETED" != "$WITH_IGNORE" ]] && PASS=$((PASS + 1)) || fail "deletion must change the hash"

report
