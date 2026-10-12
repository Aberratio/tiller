#!/usr/bin/env bash
# Provision the maps repo /wayfinder charts into. Idempotent: safe to re-run, and re-run is the
# normal way to add a project label.
#
#   WAYFINDER_MAPS_REPO=<owner>/<repo> ./setup-wayfinding.sh             # repo + the five wayfinder:* labels
#   WAYFINDER_MAPS_REPO=<owner>/<repo> ./setup-wayfinding.sh web api     # ... plus a project:<name> label each
#
# The repo is private and separate from every delivery tracker on purpose: a decision ticket on a
# sprint board distorts the board and leaks internal vocabulary into it.
set -euo pipefail

MAPS="${WAYFINDER_MAPS_REPO:-}"
[ -n "$MAPS" ] || { echo "setup-wayfinding: set WAYFINDER_MAPS_REPO=<owner>/<repo> (the profile's ## wayfinding maps repo)" >&2; exit 2; }

command -v gh >/dev/null || { echo "setup-wayfinding: gh not on PATH" >&2; exit 2; }

if gh repo view "$MAPS" >/dev/null 2>&1; then
  echo "repo $MAPS: exists"
else
  gh repo create "$MAPS" --private \
    --description "Wayfinder maps. Decision tickets only; deliverables live in each project's own tracker."
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

label wayfinder:map       "0e8a16" "The map: notes, decisions so far, and what is still fog"
label wayfinder:research  "1d76db" "Answer a question against reality"
label wayfinder:prototype "5319e7" "Throwaway code that answers a design question"
label wayfinder:grilling  "b60205" "Attack something that already exists"
label wayfinder:task      "fbca04" "Do a thing the map already decided"

for proj in "$@"; do
  label "project:$proj" "ededed" "Map belongs to the $proj project"
done

echo
echo "Done. Next: append wayfinding/issue-tracker-section.md to the project's docs/agents/issue-tracker.md,"
echo "then fill the profile's ## wayfinding section."
