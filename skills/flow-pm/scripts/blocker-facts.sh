#!/usr/bin/env bash
# blocker-facts.sh - is every "is blocked by" relation on the board still a fact?
#
# Two tracker-tool constraints shape this. The JQL search tool may reject a `fields` parameter,
# so the response carries full descriptions and spills to a file - hence jq over a file, never
# a whole read. And `resolutiondate` can come back null for every issue through that tool, so a
# check built on it reports "nothing resolved" -> "nothing stale": green at zero coverage. The
# signal is status.statusCategory.key, which does come back.
#
# Usage:
#   blocker-facts.sh [--canary <KEY>] keys     <board.json>                 # prints the JQL to run
#   blocker-facts.sh [--canary <KEY>] classify <board.json> <response.json> # verdicts; nonzero on trouble
#   blocker-facts.sh [--canary <KEY>] emit     <board.json> <response.json> # v2 snapshot on stdout
#
# The canary is the profile's `## board` Canary (or BLOCKER_FACTS_CANARY): a ticket known done
# and terminal. There is no default - a canary from another project is absent from every read.
#
# Exit codes: 0 every relation open  |  1 stale/never relations found
#             2 instrument failed - no verdict issued  |  3 usage/input error

set -uo pipefail

# A blocker in one of these statuses will never be satisfied: closed as not-going-to-happen
# rather than as delivered. Jira files them under statusCategory "done" exactly like a real
# Done, so status.name is the only thing that separates them. Extend deliberately.
NEVER_STATUSES=( "Won't Do" "Cancelled" "Canceled" "Duplicate" "Rejected" "Won't Fix" )

die() { printf 'blocker-facts: %s\n' "$*" >&2; exit 3; }

CANARY_DONE="${BLOCKER_FACTS_CANARY:-}"
if [[ "${1:-}" == --canary ]]; then CANARY_DONE="${2:-}"; shift 2 || die "--canary needs a key"; fi

[[ $# -ge 2 ]] || die "usage: $0 [--canary <KEY>] keys <board.json> | classify|emit <board.json> <response.json>"
# Without a known-done canary a read that silently returns nothing classifies every relation as
# open, and the check becomes a fail-open gate reporting a clean board on no data.
[[ -n "$CANARY_DONE" ]] || die "no canary: pass --canary <KEY> from the profile's ## board, or set BLOCKER_FACTS_CANARY"
MODE="$1"; BOARD="$2"
[[ -r "$BOARD" ]] || die "board snapshot not readable: $BOARD"

NEVER_JSON="$(printf '%s\n' "${NEVER_STATUSES[@]}" | jq -R . | jq -sc .)"

# Union of every blockedBy on the board, plus the canary, deduped.
requested_keys() {
  # blockedBy entries may already be v2 measurement objects ({key,verdict,...}) from a
  # prior emit, or plain key strings from a v1 board. Normalize to the key either way.
  jq -r --arg canary "$CANARY_DONE" '
    ([.tickets[]? | (.blockedBy // [])[] | if type == "object" then .key else . end] + [$canary])
    | unique | .[]' "$BOARD"
}

case "$MODE" in
keys)
  KEYS="$(requested_keys | paste -sd, -)"
  [[ -n "$KEYS" ]] || die "no blockedBy relations on the board - nothing to check"
  printf 'key in (%s) ORDER BY key ASC\n' "$KEYS"
  exit 0
  ;;
classify|emit) : ;;
*) die "unknown mode: $MODE" ;;
esac

RESP="${3:-}"
[[ -n "$RESP" && -r "$RESP" ]] || die "tracker response not readable: ${RESP:-<missing>}"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/blocker-facts.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
requested_keys > "$TMP/requested"

# --- Instrument check, BEFORE any signal is read ------------------------------
# Extract in one pass. A key whose statusCategory is absent is recorded as NULL rather
# than skipped, so a blank field is loud instead of invisible.
jq -r '.issues.nodes[]? | [.key, (.fields.status.name // "NULL"),
        (.fields.status.statusCategory.key // "NULL")] | @tsv' "$RESP" \
  | sort -u > "$TMP/read" || die "cannot parse tracker response as json: $RESP"

cut -f1 "$TMP/read" | sort -u > "$TMP/returned"

INSTRUMENT_FAIL=""

# 1. The canary must come back, and must read done. Catches the whole class of
#    "field returns empty" -> "nothing is closed" -> "nothing is stale".
CANARY_ROW="$(awk -F'\t' -v k="$CANARY_DONE" '$1==k' "$TMP/read")"
if [[ -z "$CANARY_ROW" ]]; then
  INSTRUMENT_FAIL+="canary $CANARY_DONE absent from the response"$'\n'
else
  CANARY_CAT="$(printf '%s' "$CANARY_ROW" | cut -f3)"
  if [[ "$CANARY_CAT" != "done" ]]; then
    INSTRUMENT_FAIL+="canary $CANARY_DONE reads statusCategory='$CANARY_CAT', expected 'done'"$'\n'
  fi
fi

# 2. The response must cover exactly what was asked for. A silently dropped key would
#    otherwise read as "no signal" and pass as open; an extra key means the key filter
#    was not applied and the whole read is about the wrong issues.
MISSING="$(comm -23 "$TMP/requested" "$TMP/returned" | paste -sd' ' -)"
EXTRA="$(comm -13 "$TMP/requested" "$TMP/returned" | paste -sd' ' -)"
[[ -n "$MISSING" ]] && INSTRUMENT_FAIL+="keys requested but not returned: $MISSING"$'\n'
[[ -n "$EXTRA" ]]   && INSTRUMENT_FAIL+="keys returned but not requested: $EXTRA"$'\n'

# 3. Any blocker whose statusCategory came back empty. Same fail-open class as (1),
#    but per key rather than on the canary.
NULLCAT="$(awk -F'\t' '$3=="NULL"{printf "%s ", $1}' "$TMP/read")"
[[ -n "$NULLCAT" ]] && INSTRUMENT_FAIL+="statusCategory empty for: $NULLCAT"$'\n'

if [[ -n "$INSTRUMENT_FAIL" ]]; then
  if [[ "$MODE" == emit ]]; then
    # The snapshot still has to be written, and it has to say "I do not know" rather than
    # carrying yesterday's verdict. Exit stays 2 so the caller cannot mistake this for a pass.
    jq --arg at "$(date -Iseconds)" --arg canary "$CANARY_DONE" \
       --arg why "$(printf '%s' "$INSTRUMENT_FAIL" | tr '\n' ';')" '
      .version = 2
      | .blockerCheck = {ranAt: $at, instrument: "failed", canary: $canary, why: $why}
      | .tickets |= map(
          ((.blockedBy // []) | map(if type == "object" then .key else . end)
           | map({key: ., verdict: "unknown", blockerStatus: null, measuredAt: null})) as $rel
          | .blockedBy = $rel
          | .effectivelyBlocked = ($rel | length > 0))
    ' "$BOARD" || die "emit-unknown failed"
    printf 'INSTRUMENT FAILED - every relation written as unknown\n%s' "$INSTRUMENT_FAIL" >&2
    exit 2
  fi
  printf 'INSTRUMENT FAILED - no verdict issued\n'
  printf '  %s\n' "instrument:"
  printf '%s' "$INSTRUMENT_FAIL" | sed 's/^/  - /'
  printf '\nThe read cannot be trusted, so every relation stays unknown. Do NOT record\n'
  printf 'these relations as open, and do NOT write measuredAt on them.\n'
  exit 2
fi

# --- Signal ------------------------------------------------------------------
jq -r --argjson never "$NEVER_JSON" --rawfile read "$TMP/read" '
  ($read | rtrimstr("\n") | split("\n") | map(split("\t"))
   | map({key: .[0], name: .[1], cat: .[2]})
   | INDEX(.key)) as $blk
  | [ .tickets[]?
      | . as $t
      | ($t.blockedBy // [])[]
      | (if type == "object" then .key else . end) as $b
      | $blk[$b] as $s
      | { ticket: $t.key, ticketStatus: $t.status, blocker: $b,
          blockerStatus: $s.name,
          verdict: (if $s.cat != "done" then "open"
                    elif ($never | index($s.name)) then "never"
                    else "stale" end) } ]
  | sort_by(.verdict | if . == "never" then 0 elif . == "stale" then 1 else 2 end)
  | .[] | [.verdict, .ticket, .ticketStatus, .blocker, .blockerStatus] | @tsv
' "$BOARD" > "$TMP/verdicts" || die "classification failed"

if [[ "$MODE" == emit ]]; then
  MEASURED_AT="$(date -Iseconds)"
  jq --rawfile read "$TMP/read" --argjson never "$NEVER_JSON" \
     --arg at "$MEASURED_AT" --arg canary "$CANARY_DONE" '
    ($read | rtrimstr("\n") | split("\n") | map(split("\t"))
     | map({key: .[0], name: .[1], cat: .[2]}) | INDEX(.key)) as $blk
    | def verdict($b): $blk[$b] as $s
        | if $s == null then "unknown"
          elif $s.cat != "done" then "open"
          elif ($never | index($s.name)) then "never"
          else "stale" end;
      .version = 2
    | .blockerCheck = {ranAt: $at, instrument: "ok", canary: $canary}
    | .tickets |= map(
        ((.blockedBy // []) | map(
           if type == "object" then .key else . end
         ) | map({key: ., verdict: verdict(.),
                  blockerStatus: ($blk[.].name // null),
                  measuredAt: (if verdict(.) == "unknown" then null else $at end)})
        ) as $rel
        | .blockedBy = $rel
        | .effectivelyBlocked = ([$rel[] | select(.verdict == "open" or .verdict == "unknown")] | length > 0))
    | .blockerCheck += {
        never: ([.tickets[].blockedBy[] | select(.verdict=="never")] | length),
        stale: ([.tickets[].blockedBy[] | select(.verdict=="stale")] | length),
        open:  ([.tickets[].blockedBy[] | select(.verdict=="open")]  | length)}
  ' "$BOARD" || die "emit failed"
  exit 0
fi

printf 'instrument: ok (canary %s reads done; %s keys requested, all returned)\n\n' \
  "$CANARY_DONE" "$(wc -l < "$TMP/requested" | tr -d ' ')"

{ printf 'VERDICT\tTICKET\tSTATUS\tBLOCKER\tBLOCKER STATUS\n'; cat "$TMP/verdicts"; } \
  | column -t -s$'\t'

N_NEVER=$(awk -F'\t' '$1=="never"' "$TMP/verdicts" | wc -l | tr -d ' ')
N_STALE=$(awk -F'\t' '$1=="stale"' "$TMP/verdicts" | wc -l | tr -d ' ')
N_OPEN=$(awk -F'\t'  '$1=="open"'  "$TMP/verdicts" | wc -l | tr -d ' ')

printf '\nnever %s | stale %s | open %s\n' "$N_NEVER" "$N_STALE" "$N_OPEN"

# A ticket every one of whose blockers is closed is not blocked at all, and whatever orders work
# downstream has been treating it as if it were.
FULLY="$(awk -F'\t' '{seen[$2]++; if ($1!="open") closed[$2]++}
        END {for (t in seen) if (closed[t]==seen[t]) printf "%s ", t}' "$TMP/verdicts")"
[[ -n "$FULLY" ]] && printf 'not blocked at all (every blocker closed): %s\n' "$FULLY"

[[ $((N_NEVER + N_STALE)) -gt 0 ]] && exit 1
exit 0
