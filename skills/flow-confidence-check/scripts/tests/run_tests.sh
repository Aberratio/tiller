#!/usr/bin/env bash
set -eo pipefail
cd "$(dirname "$0")"
rc=0
for t in ./*_test.sh; do
  echo "== $t"
  bash "$t" || rc=1
done
exit $rc
