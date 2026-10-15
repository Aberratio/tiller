#!/usr/bin/env bash
# Keeps the machine from idle-sleeping while an unattended run lives. Never fails the run: without a
# working inhibitor it prints one warning line on stderr and the run goes on uninhibited.
#
#   inhibit.sh --pid <pid>          inhibit until <pid> exits, then return at once
#   inhibit.sh <command> [args...]  inhibit, then exec the command (same pid, so signals reach it)
#   source inhibit.sh; tiller_inhibit <pid>
#
# macOS uses `caffeinate -i -w <pid>`; elsewhere `systemd-inhibit --what=idle:sleep` holding a loop
# that ends with <pid>. Env: TILLER_NO_INHIBIT=1 opts out; INHIBIT_PATH is where the inhibitors are
# looked up (default PATH; tests point it at stubs).

tiller_inhibit() {
  local pid="$1" lookup="${INHIBIT_PATH:-$PATH}" tool
  [[ "${TILLER_NO_INHIBIT:-}" == "1" ]] && return 0
  if tool="$(PATH="$lookup" command -v caffeinate 2>/dev/null)" && [[ -n "$tool" ]] && "$tool" -i true >/dev/null 2>&1; then
    nohup "$tool" -i -w "$pid" </dev/null >/dev/null 2>&1 &
    return 0
  fi
  if tool="$(PATH="$lookup" command -v systemd-inhibit 2>/dev/null)" && [[ -n "$tool" ]] &&
    "$tool" --what=idle:sleep --who=tiller --why="unattended run" true >/dev/null 2>&1; then
    nohup "$tool" --what=idle:sleep --who=tiller --why="unattended run" \
      sh -c 'while kill -0 "$1" 2>/dev/null; do sleep 30; done' sh "$pid" </dev/null >/dev/null 2>&1 &
    return 0
  fi
  echo "inhibit: no working caffeinate or systemd-inhibit; the machine may sleep during the run" >&2
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${1:-}" == "--pid" ]]; then
    [[ -n "${2:-}" ]] || { echo "usage: inhibit.sh --pid <pid> | inhibit.sh <command> [args...]" >&2; exit 1; }
    tiller_inhibit "$2"
    exit 0
  fi
  [[ $# -gt 0 ]] || { echo "usage: inhibit.sh --pid <pid> | inhibit.sh <command> [args...]" >&2; exit 1; }
  tiller_inhibit "$$"
  exec "$@"
fi
