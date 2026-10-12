<!--
Append this to the project's docs/agents/issue-tracker.md, below whatever that file
already says about the project's own tracker. Replace <PROFILE> with the profile name
(the folder name under profiles/) and <MAPS_REPO> with the maps repo from the profile's
## wayfinding section.

Nothing above this line changes: deliverables keep living in the project's own tracker.
-->

## Wayfinding operations

Used by `/wayfinder`. **Maps do not live in this project's tracker.** They live in a separate
private GitHub repo, `<MAPS_REPO>`, because a wayfinder ticket is a decision to be made,
not work to be delivered — on a delivery board it distorts the sprint and leaks internal vocabulary
into tickets that are supposed to carry none.

Set once, and used verbatim below:

```bash
MAPS=<MAPS_REPO>
PROJ=<PROFILE>            # label prefix that keeps this project's maps apart from the others
```

Every issue created here is labelled `project:$PROJ` as well as its `wayfinder:*` label. That label
is how a map from another project stays out of this project's frontier.

- **Map** — one issue labelled `wayfinder:map` holding the Notes / Decisions-so-far / Fog body:
  `gh issue create -R "$MAPS" --label wayfinder:map --label "project:$PROJ" --title "..."`.

- **Child ticket** — an issue in the same repo, attached to the map as a native sub-issue. The
  endpoint takes the child's numeric **database id**, not its `#number`:
  ```bash
  CHILD=$(gh issue create -R "$MAPS" --label "wayfinder:research" --label "project:$PROJ" \
            --title "..." --body "..." | grep -o '[0-9]*$')
  CHILD_ID=$(gh api "repos/$MAPS/issues/$CHILD" --jq .id)
  gh api --method POST "repos/$MAPS/issues/$MAP/sub_issues" -F "sub_issue_id=$CHILD_ID"
  ```
  Type label is one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`,
  `wayfinder:task`.

- **Blocking** — native issue dependencies, again by database id:
  ```bash
  BLOCKER_ID=$(gh api "repos/$MAPS/issues/$BLOCKER" --jq .id)
  gh api --method POST "repos/$MAPS/issues/$CHILD/dependencies/blocked_by" -F "issue_id=$BLOCKER_ID"
  ```

- **Frontier query** — open children of the map, minus anything with an open blocker, minus anything
  already assigned; first in map order wins:
  ```bash
  gh api "repos/$MAPS/issues/$MAP/sub_issues" --paginate \
    --jq '.[] | select(.state=="open") | select(.assignees|length==0) | .number' |
  while read -r n; do
    open_blockers=$(gh api "repos/$MAPS/issues/$n/dependencies/blocked_by" --paginate \
                      --jq '[.[] | select(.state=="open")] | length')
    [ "$open_blockers" -eq 0 ] && echo "$n"
  done
  ```
  **Read the `dependencies/blocked_by` list and check each blocker's `state`. Do not use
  `issue_dependencies_summary.blocked_by`** — that counter is eventually consistent and lagged a
  write by 2–4 seconds in both directions when measured, while the list
  endpoint was correct on every read. Charting creates tickets and then wires the edges, so the
  frontier is queried inside exactly that window: the summary field will hand out a blocked ticket
  as takeable, and no later step catches it.

- **Claim** — `gh issue edit -R "$MAPS" <n> --add-assignee @me`, the session's first write.

- **Resolve** — `gh issue comment -R "$MAPS" <n> --body "<answer>"`, then
  `gh issue close -R "$MAPS" <n>`, then append the answer's pointer to the map's Decisions-so-far.

### Crossing back into the project's tracker

A wayfinder ticket is resolved when the decision is made. Work that the decision unlocks is filed in
the project's own tracker as an ordinary ticket, written in the project's own vocabulary — no
`wayfinder:` labels, no map numbers, no skill names. The map issue may link to the delivery ticket;
the delivery ticket does not link back.
