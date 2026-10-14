#!/usr/bin/env bash
# Runs a Claude-format PreToolUse hook for Copilot CLI: the PascalCase PreToolUse payload already
# carries Claude field and tool names, but Copilot reads permissionDecision at the top level, not
# under hookSpecificOutput. Any failure exits non-zero, which Copilot treats as a deny; so does an
# empty payload, which on Windows means stdin was lost between PowerShell and Git Bash.
# Usage: copilot-pretooluse.sh <hook script>

set -uo pipefail

payload="$(cat)"
[ -n "$payload" ] || exit 1
out="$(bash "$1" <<<"$payload")" || exit 1
[ -n "$out" ] || exit 0
jq -ce 'if .hookSpecificOutput then .hookSpecificOutput | {permissionDecision, permissionDecisionReason} else . end' <<<"$out" || exit 1
