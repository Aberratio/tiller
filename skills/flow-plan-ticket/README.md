# flow-plan-ticket

Turn one already-specified ticket into an implementation plan.

The ticket arrives already written to a template - objective, success criteria, constraints, non-goals. What remains is to check whether it is still true, what it touches, and which parts of it nobody involved has permission to do.

## Where it sits

| | flow-start-ticket | **flow-plan-ticket** | flow-tdd |
|---|---|---|---|
| When | picking the ticket up | before the first test | the implementation loop |
| Owns | branch, tracker status, assignment | premise, kind, seams, hand-offs, decisions | red→green, pins, blast radius |
| Output | a branch and an In Progress ticket | the plan | the change |

flow-start-ticket hands off here, and flow-tdd opens by inheriting this skill's seam table (the list of places the change is tested) verbatim. A trivial ticket can still be planned inline in flow-start-ticket; this skill is for the ones where that would be guessing.

## Where it lives

Nothing to configure: project facts come from the resolved profile, and the repo's conventions from its own docs, every run.

The siblings do not reference this skill - `flow-tdd` names `flow-start-ticket` as the producer of its seam table, which stays correct for an install without this skill. The hand-off into and out of this skill is wired by routing, not by edits to the siblings.

## Usage

```
/flow-plan-ticket ABC-1234
"analyse ABC-1234 and plan the implementation"
"what's the plan for ABC-307?"
```

It runs in either of two modes. Interactive asks the open decisions as concrete options; autonomous decides each with a stated default and records it as overridable. Both are full paths.

## What it handles that a generic planning skill does not

- The ticket is a claim, not a description. Tickets go stale (a dependency never published, a file that changed, a number that no longer reproduces), so the premise is verified first, and the plan's first deliverable may be a corrected ticket.
- Blockers are read by what they shipped, not what they promised. The artefacts a Done blocker produced carry the contracts the new work must obey.
- Four ticket kinds, not one. A data-collection ticket, a CI ticket and a diagnosed bug each need a different spine; the TDD spine fits only the first kind.
- The steps nobody can take. `maintain` is not `admin`, a handed-over token can be dead, and a publish is immutable. Found at plan time, an unexecutable criterion becomes a hand-off with a fallback rather than a ticket closed over work that never happened.
- Decisions survive into review. The plan's "decisions taken, overridable" section stops flow-code-review's Spec axis from reporting a pre-agreed choice as scope creep.
- No placeholders. Real versions, licences, hashes and field names are looked up while planning.

## Requirements

- `git`, and `gh` for the permission and merge-rule probes
- A tracker MCP for ticket resolution (for tracker kind `jira`, the Atlassian MCP; optional - you can paste the ticket)

## Provenance

Every rule here is traceable to a session where its absence cost time.
