#!/usr/bin/env bash
# One command, no network: runs the resilience test suite plus the shared contract self-check
# these scripts are built against.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "$HERE/../contract/validate.mjs"
node --test "$HERE"/tests/*.test.mjs
