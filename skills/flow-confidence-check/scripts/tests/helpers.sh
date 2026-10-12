#!/usr/bin/env bash
# Shared helpers for flow-confidence-check script tests. Source this file.
set -eo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL_COUNT=0

fail() {
  echo "FAIL: $1" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
  else
    fail "$label
  expected: $(printf '%q' "$expected")
  actual:   $(printf '%q' "$actual")"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    PASS=$((PASS + 1))
  else
    fail "$label
  expected to contain: $needle
  actual: $haystack"
  fi
}

report() {
  echo "passed: $PASS, failed: $FAIL_COUNT"
  [[ "$FAIL_COUNT" -eq 0 ]]
}

# Fixture repo layout (branch feature, no origin remote - exercises the
# local-branch fallback for --base):
#   main:    app/services/base.rb, db/schema.rb, app/models/gone.rb
#   feature: + app/services/foo.rb (committed)
#            + spec/services/foo_spec.rb (committed)
#            ~ app/services/base.rb (committed edit)
#            ~ db/schema.rb (committed edit)
#            - app/models/gone.rb (committed delete)
#            ~ app/services/foo.rb (unstaged edit on top)
#            + app/untracked.rb (untracked)
make_fixture_repo() {
  local dir="$1"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email test@test.invalid
  git -C "$dir" config user.name test
  mkdir -p "$dir/app/services" "$dir/app/models" "$dir/db"
  echo base > "$dir/app/services/base.rb"
  echo schema > "$dir/db/schema.rb"
  echo gone > "$dir/app/models/gone.rb"
  git -C "$dir" add -A
  git -C "$dir" commit -qm base
  git -C "$dir" checkout -qb feature
  mkdir -p "$dir/spec/services"
  echo foo > "$dir/app/services/foo.rb"
  echo spec > "$dir/spec/services/foo_spec.rb"
  echo edited >> "$dir/app/services/base.rb"
  echo edited >> "$dir/db/schema.rb"
  git -C "$dir" rm -q app/models/gone.rb
  git -C "$dir" add -A
  git -C "$dir" commit -qm feature-work
  echo unstaged >> "$dir/app/services/foo.rb"
  echo untracked > "$dir/app/untracked.rb"
}
