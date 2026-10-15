#!/usr/bin/env bash
# Deterministic supervisor for thin orchestrator sessions.
#
# Spawns bounded `claude -p` children one at a time until the run's state.md says
# `supervisor: done`. A shell loop on purpose: no context to grow, no cost per tick, and the only
# decision it takes is reading the state. Waves, gates and signatures belong to the child and the
# driver it runs. A child that dies leaves its checkpoints behind; the next child resumes
# from them through `state.mjs resume`, so a killed run never restarts a whole wave.
#
# Usage: supervise.sh <brief-file>
#   brief-file   the task for every child; the supervisor wraps it with the state contract
#
# Env:
#   STATE_ROOT                 run directory (or FLOW_PROFILE + FLOW_RUN, see lib/state/state.mjs)
#   SUPERVISE_MAX_SPAWNS       default caps.supervisorSpawns
#   SUPERVISE_NO_PROGRESS      consecutive spawns with an unchanged state hash before giving up,
#                              default caps.noProgressSpawns
#   SUPERVISE_STOP_HOUR        local hour (0-23) from which no child is spawned; unset = none
#   SUPERVISE_MAX_TURNS        --max-turns per child, default 120
#   SUPERVISE_MAX_BUDGET_USD   --max-budget-usd per child, default budgetsUsd.run in config/routing.json
#   SUPERVISE_DISALLOWED_TOOLS space-separated tool names removed from every child
#   SUPERVISE_SLEEP            seconds between spawns, default 60
#   SUPERVISE_SLEEP_CMD        command used to sleep, default `sleep` (tests inject a recorder)
#   SUPERVISE_CLASSIFY         failure classifier, default lib/resilience/classify-failure.mjs
#   SUPERVISE_DRY=1            print the child command instead of running it, then exit 0
#   SUPERVISE_LOG_MAX_BYTES    supervisor.log is moved to supervisor.log.1 once over this size,
#                              default 10485760 (10 MB); one old log is kept
#
# Stdout: one script-result line. Exit: 0 done, 1 `claude` not on PATH, 2 spawn cap, 3 stop hour,
# 5 no progress, 6 usage pause that cannot be waited out, 128+n killed by signal n (HUP, INT, TERM;
# the running child's process group is killed first).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$(cd "$HERE/.." && pwd)"
STATE="$LIB/state/state.mjs"

BRIEF="${1:-}"
[[ -n "$BRIEF" && -f "$BRIEF" ]] || { echo '{"status":"error","kind":"script-error","reason":"usage: supervise.sh <brief-file>"}'; exit 1; }

capdef() { node -e "process.stdout.write(String(require('$LIB/contract/kinds.json').caps['$1'].default))"; }

if [[ -z "${STATE_ROOT:-}" ]]; then
  [[ -n "${FLOW_PROFILE:-}" && -n "${FLOW_RUN:-}" ]] || { echo '{"status":"refused","kind":"policy","reason":"STATE_ROOT unset and FLOW_PROFILE/FLOW_RUN not both given"}'; exit 4; }
  STATE_ROOT="$HOME/.claude/run-state/$FLOW_PROFILE/$FLOW_RUN"
fi
export STATE_ROOT
RUN_ID="${FLOW_RUN:-$(basename "$STATE_ROOT")}"
STATE_MD="$STATE_ROOT/state.md"
LOG="$STATE_ROOT/supervisor.log"
MAX_SPAWNS="${SUPERVISE_MAX_SPAWNS:-$(capdef supervisorSpawns)}"
NO_PROGRESS="${SUPERVISE_NO_PROGRESS:-$(capdef noProgressSpawns)}"
USAGE_WAIT_MIN="$(capdef usageWaitMinutes)"
USAGE_WAITS_MAX="$(capdef usageWaitsPerDay)"
STOP_HOUR="${SUPERVISE_STOP_HOUR:-}"
MAX_TURNS="${SUPERVISE_MAX_TURNS:-120}"
# 75 mirrors the shipped budgetsUsd.run, for a checkout whose routing.json lacks it.
MAX_BUDGET="${SUPERVISE_MAX_BUDGET_USD:-$(node -e "try { const b = require('$LIB/../config/routing.json').budgetsUsd; process.stdout.write(String(b.run ?? 75)) } catch { process.stdout.write('75') }")}"
SLEEP="${SUPERVISE_SLEEP:-60}"
SLEEP_CMD="${SUPERVISE_SLEEP_CMD:-sleep}"
CLASSIFY="${SUPERVISE_CLASSIFY:-$LIB/resilience/classify-failure.mjs}"
DRY="${SUPERVISE_DRY:-0}"
LOG_MAX="${SUPERVISE_LOG_MAX_BYTES:-10485760}"
# A print-mode child must be able to await a whole wave of background children.
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-21600000}"

mkdir -p "$STATE_ROOT"
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
rotate_log() {
  [[ -f "$LOG" ]] || return 0
  local size
  size="$(wc -c <"$LOG" | tr -d ' ')"
  (( size > LOG_MAX )) && mv -f "$LOG" "$LOG.1"
  return 0
}
logline() { rotate_log; printf '%s %s\n' "$(stamp)" "$*" | tee -a "$LOG" >&2; }
finish() {  # code, json
  logline "exit $1: $2"
  printf '%s\n' "$2"
  exit "$1"
}

# The child leads its own process group (job control below), so one kill reaches the CLI and every
# tool subprocess it started.
CHILD=""
kill_child() {
  [[ -n "$CHILD" ]] || return 0
  local pid="$CHILD"
  CHILD=""
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 -- "-$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -KILL -- "-$pid" 2>/dev/null
  return 0
}
on_signal() {  # name, number
  kill_child
  finish "$((128 + $2))" "{\"status\":\"error\",\"kind\":\"script-error\",\"reason\":\"killed by SIG$1\",\"spawns\":${SPAWNS:-0}}"
}
trap 'on_signal HUP 1' HUP
trap 'on_signal INT 2' INT
trap 'on_signal TERM 15' TERM
trap 'kill_child' EXIT
# A trap runs only once a foreground command returns; a waited background sleep lets a signal land now.
nap() { "$SLEEP_CMD" "$1" & wait $!; }

run_done() { [[ -f "$STATE_MD" ]] && grep -qE '^supervisor: done' "$STATE_MD"; }
state_hash() { node "$STATE" hash | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).hash||""))'; }
lines() { [[ -f "$STATE_MD" ]] && wc -l <"$STATE_MD" | tr -d ' ' || echo 0; }

child_prompt() {
  cat <<EOF
You are a thin orchestrator for run $RUN_ID, spawn $SPAWNS of at most $MAX_SPAWNS. Continue the run.
State, in this order: $STATE_MD (the last "## Handoff" says what is running and the next action), $STATE_ROOT/decisions.jsonl (open decisions), then the brief below.
Read only state files and dispatch results; every diagnose, fix, rebase or measurement goes to a subagent. A ticket that already has checkpoints restarts from \`node $STATE resume <ticket>\`, never from its first phase.
All state writes go through \`node $STATE\`. Before you stop (turn limit, large context, end of a wave) run \`node $STATE handoff '<what runs, what waits on a human, next action>'\`. When the queue is empty or nothing can move without a human, run \`node $STATE handoff --done\`. On a usage limit run \`node $STATE handoff --pause <reset ISO time>\` and stop.
No outbound messages and no questions: this session has no interactive turn.

## Brief
$(cat "$BRIEF")
EOF
}

SPAWN_OUT=""
SPAWN_RC=0
spawn_child() {
  local -a cmd=(claude -p "$(child_prompt)" --permission-mode auto --max-turns "$MAX_TURNS"
    --max-budget-usd "$MAX_BUDGET" --output-format json --name "flow-$RUN_ID-$SPAWNS")
  if [[ -n "${SUPERVISE_DISALLOWED_TOOLS:-}" ]]; then
    # shellcheck disable=SC2206
    local -a tools=($SUPERVISE_DISALLOWED_TOOLS)
    cmd+=(--disallowedTools "${tools[@]}")
  fi
  if [[ "$DRY" == "1" ]]; then
    printf 'DRY: ' >&2
    printf '%q ' "${cmd[@]}" >&2
    printf '\n' >&2
    return 0
  fi
  logline "spawn #$SPAWNS start"
  local out="$STATE_ROOT/last-spawn-stdout.log"
  SPAWN_RC=0
  set -m
  "${cmd[@]}" <"/dev/null" >"$out" 2>>"$LOG" &
  CHILD=$!
  set +m
  wait "$CHILD" || SPAWN_RC=$?
  CHILD=""
  SPAWN_OUT="$(cat "$out" 2>/dev/null)"
  printf '%s spawn #%s exit=%s result=%s\n' "$(stamp)" "$SPAWNS" "$SPAWN_RC" "$SPAWN_OUT" >>"$LOG"
  logline "spawn #$SPAWNS exit=$SPAWN_RC"
}

# Reset time of a usage limit hit by the last spawn, or nothing. The child's own pause line wins;
# otherwise the classifier reads the child's output (a child killed by the limit cannot write).
usage_reset() {
  local before="$1" line
  line="$(tail -n +"$((before + 1))" "$STATE_MD" 2>/dev/null | grep -E '^supervisor: paused-usage ' | tail -1)"
  if [[ -n "$line" ]]; then echo "${line#supervisor: paused-usage }"; return; fi
  [[ "$SPAWN_RC" -ne 0 && -x "$CLASSIFY" ]] || return 0
  local f="$STATE_ROOT/last-spawn-output.log"
  printf '%s' "$SPAWN_OUT" >"$f"
  "$CLASSIFY" "$f" --exit-code "$SPAWN_RC" 2>>"$LOG" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const r=JSON.parse(s.trim().split("\n").pop()); if (r.kind==="usage-limit") process.stdout.write(r.retryAfter||"unknown") } catch {}
    })'
}

# Seconds to wait for a reset, or nothing when it cannot be waited out here.
usage_wait_seconds() {
  RESET="$1" MAXMIN="$USAGE_WAIT_MIN" STOP="$STOP_HOUR" node -e '
    const r = Date.parse(process.env.RESET); if (Number.isNaN(r)) process.exit(0)
    const s = Math.max(0, Math.ceil((r - Date.now()) / 1000))
    if (s > Number(process.env.MAXMIN) * 60) process.exit(0)
    const wake = new Date(r); if (process.env.STOP !== "" && wake.getHours() >= Number(process.env.STOP)) process.exit(0)
    process.stdout.write(String(s + 5 + Math.floor(Math.random() * 25)))'
}

if [[ "$DRY" != "1" ]] && ! command -v claude >/dev/null 2>&1; then
  finish 1 '{"status":"error","kind":"script-error","reason":"claude not found on PATH"}'
fi

SPAWNS=0
UNCHANGED=0
USAGE_WAITS=0
logline "supervisor start root=$STATE_ROOT max_spawns=$MAX_SPAWNS stop_hour=${STOP_HOUR:-none} dry=$DRY"
while :; do
  run_done && finish 0 '{"status":"ok","reason":"supervisor: done"}'
  (( SPAWNS >= MAX_SPAWNS )) && finish 2 "{\"status\":\"pending\",\"reason\":\"spawn cap $MAX_SPAWNS reached without done\",\"spawns\":$SPAWNS}"
  if [[ -n "$STOP_HOUR" ]] && (( 10#$(date +%H) >= STOP_HOUR )); then
    finish 3 "{\"status\":\"blocked\",\"kind\":\"stop-hour\",\"reason\":\"stop hour $STOP_HOUR reached\",\"spawns\":$SPAWNS}"
  fi
  SPAWNS=$((SPAWNS + 1))
  before_hash="$(state_hash)"
  before_lines="$(lines)"
  spawn_child
  [[ "$DRY" == "1" ]] && finish 0 '{"status":"ok","reason":"dry run"}'
  run_done && continue

  reset="$(usage_reset "$before_lines")"
  if [[ -n "$reset" ]]; then
    wait_s=""
    (( USAGE_WAITS < USAGE_WAITS_MAX )) && wait_s="$(usage_wait_seconds "$reset")"
    if [[ -z "$wait_s" ]]; then
      if [[ "$reset" == "unknown" ]]; then
        finish 6 '{"status":"paused-usage","kind":"usage-limit","reason":"usage limit, reset time unknown"}'
      fi
      finish 6 "{\"status\":\"paused-usage\",\"kind\":\"usage-limit\",\"reason\":\"usage limit\",\"retryAfter\":\"$reset\"}"
    fi
    USAGE_WAITS=$((USAGE_WAITS + 1))
    UNCHANGED=0
    logline "usage limit until $reset — waiting ${wait_s}s ($USAGE_WAITS/$USAGE_WAITS_MAX)"
    nap "$wait_s"
    continue
  fi

  if [[ "$(state_hash)" == "$before_hash" ]]; then
    UNCHANGED=$((UNCHANGED + 1))
    logline "spawn #$SPAWNS left state unchanged ($UNCHANGED/$NO_PROGRESS)"
    (( UNCHANGED >= NO_PROGRESS )) && finish 5 "{\"status\":\"no-progress\",\"kind\":\"no-progress\",\"reason\":\"$UNCHANGED consecutive spawns left state unchanged\",\"spawns\":$SPAWNS}"
  else
    UNCHANGED=0
  fi
  nap "$SLEEP"
done
