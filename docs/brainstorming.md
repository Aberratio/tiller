# Brainstorming

`flow-brainstorm` turns a goal without a ticket into one recorded decision. The record holds at
least three materially different options, the recommendation and the runner-up it beat, and what
reversing the choice would cost. It produces no plan and no code. A written ticket goes to
`flow-plan-ticket`, and a whole new project goes to `flow-discovery`.

## Where the decision is recorded

The skill uses the first destination that applies:

1. **A brain register**: a granted brain with write access and a `decisions.md`. The decision
   becomes the next `D-nnn`, and each assumption becomes a `Q-nnn`.
2. **The ticket's decision ledger**: used when a profile resolves and the branch carries a ticket
   key.
3. **The profile's doubt log**: used when a profile resolves but neither of the above applies.
4. **Nowhere durable**: reported as such, with the command that creates a pet brain.

It never writes a tracked spec file.

## The checker

`skills/flow-brainstorm/scripts/brainstorm.mjs` has no dependencies. It checks the session's shape
and renders each output: the table, the question, an `awaiting[]` item, a ledger line and a
doubt-log block. It also writes the brain record. The session format is described in
`skills/flow-brainstorm/references/session.md`.

```bash
bash skills/flow-brainstorm/scripts/run-tests.sh
```
