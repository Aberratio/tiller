---
name: flow-chart-effort
description: Plan an effort too big for one agent session as a shared map of decision tickets in the profile's private maps repo, then resolve them one per session until the way to the destination is clear. Use for "chart this", "map out this effort", "work through the map", or a map URL.
disable-model-invocation: true
---

# flow-chart-effort

A loose idea has arrived, too big for one agent session and wrapped in fog: the way from here to the
**destination** is not visible yet. This skill charts the way as a **shared map** of **decision
tickets** (questions whose resolution is a decision, not slices of a build) and works them one at a
time until the route is clear.

The destination varies per effort, and naming it is the first act of charting: a spec to hand off, a
decision to lock before planning starts, a change made in place such as a data migration. The map is
domain-agnostic.

## Step −1 — Resolve the project profile

Read `$TILLER_HOME/skills/_shared/resolve-profile.md` and follow it; no profile resolves → stop.

Reads `## charting`. `Maps repo: none`, or the section absent → stop and say the project does not
chart; provisioning is `$TILLER_HOME/skills/flow-chart-effort/scripts/setup-maps-repo.sh` (header
has usage), and the repo then goes into the profile by hand.

## Plan, don't do

Charting is **planning** by default: each ticket resolves a decision, and the map is done when
nothing is left to decide before someone does the thing. The pull to just do the work is the signal
you have reached the edge of the map and it is time to hand off. An effort can carry execution into
the map by saying so in its **Notes**; absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket is an issue, so it has a **name**: its title. In everything the human reads
(narration, the map's Decisions so far) refer to it by name, with the link wrapped inside the name.
A wall of `#42, #43, #44` is illegible; names read at a glance.

## The maps repo

Maps live in the profile's maps repo, one private GitHub repo apart from every project's tracker. A
decision ticket is not a deliverable: on a delivery board it distorts the board and leaks internal
vocabulary into tickets that must carry none. Whatever a map decides crosses back into the project's
own tracker as an ordinary ticket in the project's vocabulary, with no `chart:` labels, map numbers
or skill names. The map may link to that ticket; the ticket does not link back.

Set once per session from the profile, and used verbatim below:

```bash
MAPS=<Maps repo>
PROJ=<profile name>      # every issue also carries project:$PROJ, which keeps other projects' maps off this frontier
```

The six **operations**, the only way this skill touches the repo:

- **Map**: `gh issue create -R "$MAPS" --label chart:map --label "project:$PROJ" --title "..." --body "..."`
- **Child ticket**: a native sub-issue of the map. The endpoint takes the child's database id, not
  its `#number`:
  ```bash
  CHILD=$(gh issue create -R "$MAPS" --label "chart:<type>" --label "project:$PROJ" \
            --title "..." --body "..." | grep -o '[0-9]*$')
  CHILD_ID=$(gh api "repos/$MAPS/issues/$CHILD" --jq .id)
  gh api --method POST "repos/$MAPS/issues/$MAP/sub_issues" -F "sub_issue_id=$CHILD_ID"
  ```
- **Blocking**: native issue dependencies, again by database id:
  ```bash
  BLOCKER_ID=$(gh api "repos/$MAPS/issues/$BLOCKER" --jq .id)
  gh api --method POST "repos/$MAPS/issues/$CHILD/dependencies/blocked_by" -F "issue_id=$BLOCKER_ID"
  ```
- **Frontier query**: open, unassigned children with no open blocker, in map order. It reads the
  `blocked_by` list and each blocker's `state`, because the `issue_dependencies_summary` counter lags
  a write by seconds and would hand out a blocked ticket right after charting wires the edges:
  ```bash
  gh api "repos/$MAPS/issues/$MAP/sub_issues" --paginate \
    --jq '.[] | select(.state=="open") | select(.assignees|length==0) | .number' |
  while read -r n; do
    open_blockers=$(gh api "repos/$MAPS/issues/$n/dependencies/blocked_by" --paginate \
                      --jq '[.[] | select(.state=="open")] | length')
    [ "$open_blockers" -eq 0 ] && echo "$n"
  done
  ```
- **Claim**: `gh issue edit -R "$MAPS" <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment -R "$MAPS" <n> --body "<answer>"`, then `gh issue close -R "$MAPS" <n>`,
  then append the answer's pointer to the map's Decisions so far.

## The map

One issue labelled `chart:map`, the canonical artifact; its tickets are its sub-issues. The map is an
**index**, not a store: a decision lives in exactly one place, its ticket, and the map only gists it
and links. Open tickets are not listed in the body; they are found by the frontier query.

```markdown
## Destination

<what reaching the end of this map looks like: the spec, decision, or change. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- one line per closed ticket, enough to judge relevance; zoom the link for the detail -->

- [<closed ticket title>](link): <one-line gist of the answer>

## Not yet specified

<!-- in-scope fog you cannot ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- work ruled beyond the destination; closed, never graduates -->
```

## Tickets

A ticket's body is the question, sized to one agent session:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

The answer is recorded on resolution, not in the body. Assets made while resolving are linked from
the issue, not pasted in. A ticket is **unblocked** when every ticket blocking it is closed; the
**frontier** is the open, unblocked, unclaimed children, the edge of the known. An assignee is the
claim; an open, unassigned ticket is unclaimed.

Each ticket carries one type label. **HITL** tickets are worked with a human who speaks for
themselves, and resolve only through that live exchange; the agent never answers its own questions.
**AFK** tickets are driven by the agent alone.

- `chart:research` (AFK): surface a fact a decision waits on from documentation, third-party APIs or
  a knowledge base. Resolved by a subagent that calls the Skill tool with "research".
- `chart:prototype` (HITL): raise the fidelity of the discussion with a cheap, rough artifact to react
  to (an outline, a stub, UI or logic code) via the Skill tool with "prototype"; link it as an asset.
  For "how should it look" or "how should it behave".
- `chart:grilling` (HITL): conversation, the default. Call the Skill tool for "grilling" and for
  "domain-modeling".
- `chart:task` (HITL or AFK): work that must happen before a decision can be made (signing up for a
  service so its API can be judged, provisioning access, moving data so its shape can be seen). The
  one type that does rather than decides, and it earns its place by unblocking a decision. The agent
  drives it alone where it can, and otherwise hands the human a precise checklist. The answer records
  what was done and the facts later tickets depend on (where a credential lives, new URLs, row counts).

## Fog of war

The map is deliberately incomplete. Beyond the live tickets lies the **fog of war**: decisions you
can tell are coming but cannot pin down, because they hang on questions still open. Resolving a
ticket clears the fog ahead of it, graduating whatever is now specifiable into fresh tickets, until
no tickets remain.

**Not yet specified** is where that dim view is written down, as loosely or fully as the view
allows. Everything there is in scope, just not sharp enough to ticket. The test is whether you can
state the question precisely now, not whether you can answer it now: a sharp question becomes a
ticket even when blocked, and a blurry one stays fog, unsliced, since one patch may graduate into
several tickets or none.

## Out of scope

The destination fixes the scope; work beyond it is **out of scope**, not fog, and never graduates. It
returns only if the destination is redrawn, as a fresh effort. When an existing ticket turns out to
sit past the destination, **close it** and leave one line in **Out of scope**: the gist, why, and the
link. It stays out of Decisions so far, which records the route actually walked.

## Invocation

Two modes. Either way, **one ticket resolved per session**, research tickets excepted.

### Chart the map

The human brings a loose idea.

1. **Name the destination.** Call the Skill tool for "grilling" and for "domain-modeling" to pin down
   the spec, decision or change this map is finding its way to.
2. **Map the frontier.** Grill again, **breadth-first**: fan out across the whole space, surfacing
   the open decisions and the first steps takeable now. No fog surfaces (the whole journey fits one
   session) → no map; stop and ask the human how to proceed.
3. **Create the map**: Destination and Notes filled in, Decisions so far empty, the fog sketched into
   Not yet specified.
4. **Create the tickets you can specify now** as children, then wire blocking in a **second pass**
   (issues need ids before they can reference each other).
5. **Fire the research subagents**, one per `chart:research` ticket, each calling the Skill tool with
   "research" and capturing findings on a throwaway `research/<name>` branch with a pointer from the
   ticket.
6. Stop. Charting resolves nothing by hand.

### Work through the map

The human brings a map (URL or number), optionally a ticket. Without one, you pick the next decision.

1. Load the **map**: the low-resolution view, not every ticket body.
2. Choose the ticket: the one named, else the first on the frontier. **Claim it** before any work.
3. Resolve it. **Zoom** as needed into related or closed tickets; call the skills the map's Notes
   name, and when in doubt "grilling" and "domain-modeling".
4. Record the resolution: comment, close, append the pointer to Decisions so far.
5. Create newly surfaced tickets (create, then wire). Graduate fog the answer made specifiable,
   clearing each graduated patch from Not yet specified. Rule out of scope whatever the answer shows
   sits past the destination. Update or delete tickets the decision invalidated.

Other sessions may be working unblocked tickets of the same map at the same time.
