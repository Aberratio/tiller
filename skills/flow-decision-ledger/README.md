# flow-decision-ledger - where it splices in

The skill sits in the middle of an existing chain:

```
flow-plan-ticket  →  flow-tdd  →  flow-code-review  →  flow-confidence-check
   seeds the ledger      appends to it     reads it into 2 briefs  reads it into every agent
```

The other skills do not depend on this one; they already expose the slots it fills:

- `flow-code-review` Step 2 (spec addenda) and Step 3 (pre-declared deliberate deviations), and the
  matching slots in `references/subagent-briefs.md`.
- `flow-confidence-check` dimension-agent prompts in `references/subagent-prompts.md`.

The ledger is injected by the session that dispatches the review, not by the skill files. If flow-tdd
or flow-code-review seems to be missing a mention of the ledger, that is deliberate: without this
skill installed it would be a dead pointer.

It fires on its description, plus whatever routing the install adds to the always-loaded
instructions.

It grew out of review sessions where deviations and post-ticket agreements were pasted into sub-agent
briefs by hand, and where a missing declaration took the report's strongest finding.
