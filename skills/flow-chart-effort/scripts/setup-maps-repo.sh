#!/usr/bin/env bash
# Provision the maps repo flow-chart-effort charts into. Idempotent: safe to re-run, and re-run is the
# normal way to add a project label.
#
#   CHART_MAPS_REPO=<owner>/<repo> ./setup-maps-repo.sh             # repo + the five chart:* labels
#   CHART_MAPS_REPO=<owner>/<repo> ./setup-maps-repo.sh web api     # ... plus a project:<name> label each
#
# The repo is private and separate from every delivery tracker on purpose: a decision ticket on a
# sprint board distorts the board and leaks internal vocabulary into it.
set -euo pipefail

MAPS="${CHART_MAPS_REPO:-}"
[ -n "$MAPS" ] || { echo "setup-maps-repo: set CHART_MAPS_REPO=<owner>/<repo> (the profile's ## charting maps repo)" >&2; exit 2; }

command -v gh >/dev/null || { echo "setup-maps-repo: gh not on PATH" >&2; exit 2; }

if gh repo view "$MAPS" >/dev/null 2>&1; then
  echo "repo $MAPS: exists"
else
  gh repo create "$MAPS" --private \
    --description "Decision maps. Decision tickets only; deliverables live in each project's own tracker."
  echo "repo $MAPS: created"
fi

# A repo created from a template can land with issues off, and every operation below needs them.
if [ "$(gh api "repos/$MAPS" --jq .has_issues)" != "true" ]; then
  gh api --method PATCH "repos/$MAPS" -F has_issues=true >/dev/null
  echo "repo $MAPS: issues enabled"
fi

label() {  # name colour description
  if gh label list -R "$MAPS" --limit 200 --json name --jq '.[].name' | grep -qx "$1"; then
    echo "label $1: exists"
  else
    gh label create "$1" -R "$MAPS" --color "$2" --description "$3"
  fi
}

label chart:map       "0e8a16" "The map: notes, decisions so far, and what is still fog"
label chart:research  "1d76db" "Answer a question against reality"
label chart:prototype "5319e7" "Rough artifact to react to before deciding"
label chart:grilling  "b60205" "Settle a decision in conversation with a human"
label chart:task      "fbca04" "Work that must happen before a decision can be made"

for proj in "$@"; do
  label "project:$proj" "ededed" "Map belongs to the $proj project"
done

echo
echo "Done. Next: fill the profile's ## charting section with Maps repo: $MAPS."
