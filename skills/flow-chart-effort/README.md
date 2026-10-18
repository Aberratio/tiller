# flow-chart-effort

Plan an effort too big for one agent session as a map of decision tickets, and resolve them one per
session until nothing is left to decide.

Adapted from the public `wayfinder` skill in <https://github.com/mattpocock/skills>. The method is
unchanged: a destination, a frontier of decision tickets, fog that graduates into tickets as answers
arrive, one resolution per session. What changed is where the map lives. Upstream reads six tracker
operations out of the project's `docs/agents/issue-tracker.md`; here they are built into the skill
and point at one private maps repo named in the profile, so charting a project needs no edit in the
project's own repo.

## Where it sits

| | flow-chart-effort | flow-discovery | flow-write-ticket |
|---|---|---|---|
| When | an effort is too foggy to ticket | a new project has no spec yet | the work is known |
| Owns | the map and its decision tickets | the decision register and the spec | one delivery ticket |
| Output | decisions, until the way is clear | a spec and a roadmap | a ticket in the project's tracker |

What a map decides crosses back into the project's tracker as an ordinary ticket. Decision tickets
never go onto the delivery board.

## Setup

1. `CHART_MAPS_REPO=<owner>/<repo> scripts/setup-maps-repo.sh <profile>` creates the private repo,
   the five `chart:*` labels and a `project:<profile>` label. Idempotent; re-run it to add a project.
2. Fill the profile's `## charting` section with the repo.

Slash-only (`/flow-chart-effort`): it never starts on its own, because charting spends a session on
planning that a brainstorm or a plan might have covered.

## Provenance

The frontier query reads `dependencies/blocked_by` and each blocker's `state` instead of
`issue_dependencies_summary.blocked_by`, which upstream's GitHub template uses. The summary is
eventually consistent and was measured lagging a write by two to four seconds in both directions:

```
POST .../dependencies/blocked_by   -> summary.blocked_by = 0   (wrong)
                            +2s    -> 0                        (still wrong)
                            +4s    -> 1                        (right)
```

After a blocker closed, one dependent still reported `blocked_by=1` while another already reported
`0`. Charting creates, wires, then queries the frontier, which is exactly that window. The list
endpoint was correct on every read.
