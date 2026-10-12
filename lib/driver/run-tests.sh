#!/usr/bin/env bash
# One command, no network, no live model: driver runtime tests against a fake `claude` on PATH.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "$HERE/../contract/validate.mjs" | tail -1
node --test "$HERE"/tests/*.test.mjs
