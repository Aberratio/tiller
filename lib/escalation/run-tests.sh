#!/usr/bin/env bash
# One command, no network: the contract self-check, the escalation scenarios, and the gate tests whose
# profile rendering the scenarios rely on.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "$HERE/../contract/validate.mjs" | tail -1
node --test "$HERE"/tests/*.test.mjs "$HERE"/../gates/tests/*.test.mjs
