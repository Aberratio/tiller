# flow-decision-ledger — where it splices in

**What it splices.** It sits in the middle of an existing chain:

```
flow-plan-ticket  →  flow-tdd  →  flow-code-review  →  flow-confidence-check
   seeds the ledger      appends to it     reads it into 2 briefs  reads it into every agent
```

The other skills do not depend on this one. They already expose the slots this fills:

- `flow-code-review` Step 2 (spec addenda) and Step 3 (pre-declared deliberate deviations), and the
  matching slots in `references/subagent-briefs.md`.
- `flow-confidence-check` dimension-agent prompts in `references/subagent-prompts.md`.

So the injection happens in the session that dispatches the review, not in the skill files.
If a future session finds that flow-tdd or flow-code-review "should" mention the ledger and the
reference looks missing: it is missing deliberately — for an install without this skill it would be
a dead pointer.

**What makes it fire.** Its description, plus whatever routing the install adds to the always-loaded
instructions; everything else is here.

**Where it came from.** Review sessions where deviations and post-ticket agreements were pasted into
the sub-agent briefs by hand, and runs where a missing declaration cost the strongest finding in the
report.
