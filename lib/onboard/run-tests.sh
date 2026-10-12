#!/usr/bin/env bash
# One command, no network: onboarding tests against temp git repos and a fake `gh` on PATH, plus the
# gate and lib tests - `profile-facts.sh` decides whether a generated profile is launch-safe and
# `resolve-profile.sh` whether a repo is already claimed, so a change there has to be seen here.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node --test "$HERE"/tests/*.test.mjs "$HERE"/../gates/tests/*.test.mjs "$HERE"/../tests/*.test.mjs
