#!/usr/bin/env bash
# Tests for scripts/blocker-facts.sh: the instrument check, the four verdicts, and the snapshot it emits.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BF="$HERE/../scripts/blocker-facts.sh"
FX="$HERE/fixtures"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
node "$FX/make-responses.mjs" "$TMP"
BOARD="$FX/board.json"

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }
run() { out="$(bash "$BF" "$@" 2>"$TMP/err")"; code=$?; err="$(cat "$TMP/err")"; }

# No canary: the check cannot tell a broken read from a clean board, so it refuses to start.
BLOCKER_FACTS_CANARY='' run keys "$BOARD"
check 'no canary is a usage error' '[ "$code" = 3 ] && grep -q canary <<<"$err"'

run --canary FIX-1 keys "$BOARD"
check 'keys prints the JQL for every blocker plus the canary' \
  '[ "$code" = 0 ] && [ "$out" = "key in (FIX-1,FIX-2,FIX-3,FIX-4) ORDER BY key ASC" ]'

BLOCKER_FACTS_CANARY=FIX-1 run keys "$BOARD"
check 'the canary may come from the environment' '[ "$code" = 0 ]'

run --canary FIX-1 classify "$BOARD" "$TMP/resp-ok.json"
check 'classify exits 1 when stale or never relations exist' '[ "$code" = 1 ]'
check 'a Won'"'"'t Do blocker is never' 'grep -E "^never +FIX-10 .*FIX-3" <<<"$out" >/dev/null'
check 'a Done blocker is stale' 'grep -E "^stale +FIX-11 .*FIX-4" <<<"$out" >/dev/null'
check 'a ticket whose every blocker is closed is named' 'grep -q "not blocked at all.*FIX-11" <<<"$out"'
check 'a ticket with an open blocker is not named as unblocked' '! grep "not blocked at all" <<<"$out" | grep -q FIX-10'

run --canary FIX-1 emit "$BOARD" "$TMP/resp-ok.json"
check 'emit exits 0 on a good read' '[ "$code" = 0 ]'
check 'emit writes version 2 with the instrument ok' \
  '[ "$(jq -r "[.version, .blockerCheck.instrument, .blockerCheck.canary] | map(tostring) | join(\" \")" <<<"$out")" = "2 ok FIX-1" ]'
check 'emit measures each relation with a timestamp' \
  '[ "$(jq -r "[.tickets[].blockedBy[] | select(.measuredAt == null)] | length" <<<"$out")" = 0 ]'
check 'emit keeps a ticket with an open blocker blocked' \
  '[ "$(jq -r ".tickets[] | select(.key == \"FIX-10\") | .effectivelyBlocked" <<<"$out")" = true ]'
check 'emit unblocks a ticket whose blockers are all closed' \
  '[ "$(jq -r ".tickets[] | select(.key == \"FIX-11\") | .effectivelyBlocked" <<<"$out")" = false ]'
check 'emit counts never, stale and open' \
  '[ "$(jq -r "[.blockerCheck.never, .blockerCheck.stale, .blockerCheck.open] | map(tostring) | join(\" \")" <<<"$out")" = "1 1 1" ]'

for resp in no-canary canary-open extra null-category; do
  run --canary FIX-1 classify "$BOARD" "$TMP/resp-$resp.json"
  check "classify issues no verdict when the instrument fails ($resp)" \
    '[ "$code" = 2 ] && grep -q "INSTRUMENT FAILED" <<<"$out" && ! grep -Eq "^(open|stale|never) " <<<"$out"'
done

run --canary FIX-1 emit "$BOARD" "$TMP/resp-no-canary.json"
check 'emit on a failed instrument still exits 2' '[ "$code" = 2 ]'
check 'emit on a failed instrument writes every relation unknown with no timestamp' \
  '[ "$(jq -r "[.tickets[].blockedBy[] | select(.verdict != \"unknown\" or .measuredAt != null)] | length" <<<"$out")" = 0 ]'
check 'emit on a failed instrument never carries the previous verdict forward' \
  '[ "$(jq -r ".tickets[] | select(.key == \"FIX-11\") | .blockedBy[0].verdict" <<<"$out")" = unknown ]'
check 'emit on a failed instrument treats every linked ticket as blocked' \
  '[ "$(jq -r "[.tickets[] | select((.blockedBy | length) > 0 and .effectivelyBlocked != true)] | length" <<<"$out")" = 0 ]'
check 'emit on a failed instrument records the failure' \
  '[ "$(jq -r .blockerCheck.instrument <<<"$out")" = failed ]'

run --canary FIX-1 classify "$BOARD" "$TMP/resp-all-open.json"
check 'classify exits 0 when every relation is open' '[ "$code" = 0 ]'

echo "blocker-facts: $pass passed, $fail failed"
[ "$fail" = 0 ]
