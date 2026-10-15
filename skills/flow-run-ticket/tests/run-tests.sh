#!/usr/bin/env bash
# One command, no network, no GitHub or tracker writes, no live model: dry-run plumbing tests for the
# ticket and day drivers, against the shipped profile and the no-tracker fixture.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "$HERE/../../../lib/contract/validate.mjs" | tail -1
node --test "$HERE"/*.test.mjs "$HERE"/../../flow-run-day/tests/*.test.mjs
