# flow-start-ticket

The opening bookend of the ticket lifecycle. `flow-create-commit` and `flow-create-pull-request` already close the cycle; this skill opens it — everything between "I'll take this ticket" and the first line of code:

1. **Discover** the tracker, project key and branch convention from the project profile (`## tracker`, `## identity`, `## branching`), and the epic from the repo's own docs.
2. **Resolve** the ticket (by key, or an ordered pick-list of the project's unstarted work).
3. **Sanity-check** it: not already taken, not blocked, has an objective and acceptance criteria — offering `flow-write-ticket` to repair a vague ticket *before* work starts.
4. **Branch** from a fresh main using the profile's branch convention (default `<ticket>-<slug>`, or `<type>/<slug>` with no ticket).
5. **Update the tracker**: assign to the user, transition to In Progress.
6. **Plan briefly** (3–7 steps with test levels) and get agreement before any code.

## Usage

```
/flow-start-ticket ABC-1234
/flow-start-ticket            # pick from the project's unstarted tickets
"start work on the accuracy gate ticket"
```

## Requirements

- The tracker role's tools (`tracker.get`, `tracker.search`, `tracker.transition`, …); for kind `jira`, the Atlassian MCP
- `git` with an `origin` remote
