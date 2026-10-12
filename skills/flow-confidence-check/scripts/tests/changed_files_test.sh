#!/usr/bin/env bash
set -eo pipefail
source "$(dirname "$0")/helpers.sh"

CF="$SCRIPTS_DIR/changed-files.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
make_fixture_repo "$TMP"
cd "$TMP"

# 1. files mode: committed + unstaged + untracked, deleted file excluded
out="$(bash "$CF" 2>/dev/null)"
assert_eq "app/services/base.rb
app/services/foo.rb
app/untracked.rb
db/schema.rb
spec/services/foo_spec.rb" "$out" "files mode lists all changed files, no deleted"

# 2. merge-base SHA on stderr, matches git merge-base
err="$(bash "$CF" 2>&1 >/dev/null)"
mb="$(git merge-base main HEAD)"
assert_eq "merge-base: $mb" "$err" "merge-base printed on stderr"

# 3. --exclude drops matching files (repeatable)
out="$(bash "$CF" --exclude 'db/schema.rb' --exclude 'spec/*' 2>/dev/null)"
assert_eq "app/services/base.rb
app/services/foo.rb
app/untracked.rb" "$out" "--exclude drops schema and spec files"

# 4. --filter keeps only matching files
out="$(bash "$CF" --filter 'app/*' 2>/dev/null)"
assert_eq "app/services/base.rb
app/services/foo.rb
app/untracked.rb" "$out" "--filter keeps only app files"

# 5. exec mode substitutes {} with the file list
out="$(bash "$CF" --filter 'db/*' -- echo lint {} 2>/dev/null)"
assert_eq "lint db/schema.rb" "$out" "exec substitutes {} with files"

# 6. empty file list: command not run, exit 0, notice on stderr
err="$(bash "$CF" --filter 'nomatch/*' -- echo SHOULD_NOT_RUN 2>&1 >/dev/null)" && rc=0 || rc=$?
assert_eq "0" "$rc" "empty list exits 0"
assert_contains "$err" "nothing to run" "empty list prints notice"
out="$(bash "$CF" --filter 'nomatch/*' -- echo SHOULD_NOT_RUN 2>/dev/null)"
assert_eq "" "$out" "empty list never runs the command"

# 7. command exit code propagates
rc=0; bash "$CF" -- false {} >/dev/null 2>&1 || rc=$?
assert_eq "1" "$rc" "command exit code propagates"

# 8. explicit positional files skip the diff, still pass filter/exclude
out="$(bash "$CF" --exclude 'b.rb' a.rb b.rb 2>/dev/null)"
assert_eq "a.rb" "$out" "explicit files skip diff, exclude still applies"

# 9. invalid --mode rejected
rc=0; bash "$CF" --mode bogus >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "invalid mode exits 2"

# 10. tests mode: maps app source to existing spec, includes changed spec
#     itself, drops mappings that do not exist on disk
out="$(bash "$CF" --mode tests 2>/dev/null)"
assert_eq "spec/services/foo_spec.rb" "$out" "tests mode maps to existing specs only"

# 11. tests mode: a mapping appears once even when both the source and its
#     spec changed (dedup)
echo tweak >> spec/services/foo_spec.rb
out="$(bash "$CF" --mode tests 2>/dev/null)"
assert_eq "spec/services/foo_spec.rb" "$out" "tests mode dedups source+spec pair"

# 12. tests mode + go convention
mkdir -p pkg
echo go > pkg/thing.go
echo gotest > pkg/thing_test.go
out="$(bash "$CF" --mode tests --filter 'pkg/*' 2>/dev/null)"
assert_eq "pkg/thing_test.go" "$out" "tests mode maps go source to _test.go"

# 13. tests mode with explicit files skips mapping entirely
out="$(bash "$CF" --mode tests spec/some/explicit_spec.rb 2>/dev/null)"
assert_eq "spec/some/explicit_spec.rb" "$out" "explicit files bypass mapping"

report
