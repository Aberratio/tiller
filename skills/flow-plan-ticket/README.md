# flow-plan-ticket

Turn one already-specified ticket into an implementation plan.

Here the work arrives as a ticket that was already written to a template — objective, success criteria, constraints, non-goals. Nothing is left to specify. What is left is to find out whether the ticket is still true, what it touches, and which parts of it nobody involved has permission to do.

## Where it sits

| | flow-start-ticket | **flow-plan-ticket** | flow-tdd |
|---|---|---|---|
| When | picking the ticket up | before the first test | the implementation loop |
| Owns | branch, tracker status, assignment | premise, kind, seams, hand-offs, decisions | red→green, pins, blast radius |
| Output | a branch and an In Progress ticket | the plan | the change |

flow-start-ticket ends by handing off here; flow-tdd opens by inheriting this skill's seam table verbatim. A trivial ticket can still be planned inline inside flow-start-ticket — this skill is for the ones where that would be guessing.

## Where it lives

Nothing to configure: project facts come from the resolved profile, and the repo's conventions from its own docs, every run.

The siblings named above do not reference this skill — `flow-tdd` names `flow-start-ticket` as the producer of the seam table it inherits, which is correct for an install without this skill. The hand-off into and out of this skill is wired by routing, not by edits to the siblings.

## Usage

```
/flow-plan-ticket ABC-1234
"analyse ABC-1234 and plan the implementation"
"what's the plan for ABC-307?"
```

Runs in either mode: **interactive**, asking the open decisions as concrete options, or **autonomous**, deciding each with a stated default and recording it as overridable. Three of the sessions this skill was derived from were autonomous, which is why the second mode is a first-class path rather than a degradation.

## What it handles that a generic planning skill does not

- **The ticket is a claim, not a description.** Tickets go stale: a dependency that was never published, a file that no longer looks like that, a number that no longer reproduces. Verifying the premise has twice made the plan's first deliverable a corrected ticket.
- **Blockers are read by what they shipped**, not by what they promised. The artefacts a Done blocker produced carry the contracts the new work has to obey; the ticket text does not.
- **Four ticket kinds, not one.** A data-collection ticket, a CI ticket and a diagnosed bug each need a different spine — the TDD one fits only the first kind, and forcing it produces a plan nobody can execute.
- **The steps nobody can take.** `maintain` is not `admin`, a handed-over token can be dead on arrival, and a publish is immutable. Found at plan time, an unexecutable criterion becomes a hand-off with a fallback instead of a ticket closed as complete over work that never happened.
- **Decisions survive into review.** The plan's "decisions taken, overridable" section is what stops flow-code-review's Spec axis reporting a pre-agreed choice as scope creep.
- **No placeholders.** Real versions, licences, hashes and field names get looked up while planning, not re-derived mid-implementation.

## Requirements

- `git`, and `gh` for the permission and merge-rule probes
- A tracker MCP for ticket resolution (for tracker kind `jira`, the Atlassian MCP; optional — you can paste the ticket)

## Provenance

Every rule here is traceable to a session where its absence cost time.
