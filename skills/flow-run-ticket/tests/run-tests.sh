#!/usr/bin/env bash
# One command, no network, no GitHub or tracker writes, no live model: dry-run plumbing tests for the
# ticket and day runners (the ticket and day scenarios also through the Node driver), against the shipped profile and the no-tracker fixture.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "$HERE/../../../lib/contract/validate.mjs" | tail -1
node --test "$HERE"/*.test.mjs "$HERE"/../../flow-run-day/tests/*.test.mjs
FLOW_TARGET=node node --test "$HERE"/run-ticket.test.mjs "$HERE"/replay.test.mjs "$HERE"/../../flow-run-day/tests/run-day.test.mjs
