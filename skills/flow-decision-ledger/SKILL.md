---
name: flow-decision-ledger
description: The branch's decision ledger - one file where a deliberate deviation or a post-ticket agreement is recorded as it is taken, and which every review reads instead of being told by hand. Use when a decision goes against a repo convention or past the ticket ("we point at live data on purpose", "the owner agreed X after the ticket was written"), and BEFORE dispatching flow-code-review or flow-confidence-check so their sub-agents get the declarations instead of rediscovering them.
user-invocable: true
---

# flow-decision-ledger

## Step −1 — Resolve the project profile

Read `$TILLER_HOME/skills/_shared/resolve-profile.md` and follow it; no profile resolves → stop.

One file per branch, appended as decisions are taken, read by every review that follows:

The ledger path comes from the profile's `## decision ledger` section (`docs/superpowers/decisions/<TICKET>.md` where a project has no opinion) — ticket key from the branch name (the profile's `## commits` → `Ticket from branch:` pattern, else `[A-Z][A-Z0-9]+-[0-9]+`); no key → the branch slug. Create it with a `# <TICKET> — decision ledger` header. It is committed with the change, so the human reviewing the PR sees the same lines the sub-agents saw.

**No branch yet.** Planning can run before the branch exists (flow-plan-ticket invoked straight off a ticket key, still on `main`). Then the ticket key names the file — it is known and unambiguous — and the file is written **untracked on `main`**: an untracked file survives `git checkout -b`, so it travels onto the branch and gets committed there with the change. Never commit it to `main` to "park" it. The same holds for the plan document itself.

## The line

```
- <YYYY-MM-DD> · <spec|standards|both> · <decision> — <why> · <agreed with <who>, <where> | self>
```

Field 2 is the routing field, and it is the only thing a reader has to parse:

| tag | the decision is | reaches |
|---|---|---|
| `spec` | about what gets built, agreed after the ticket was written | the reviewer reading the ticket |
| `standards` | taken on purpose against a repo convention | the reviewer reading conventions |
| `both` | both | both |

```
- 2026-07-28 · standards · the integration test reads the live reference data instead of a frozen fixture copy — catching a change that breaks setup is the point of the test · self
- 2026-07-28 · spec · an empty batch counts as 0 processed items — the report needs a zero, not a gap · agreed with the ticket owner, planning round
```

## A line that makes a checkable claim is checked before it is written

A line containing a command, a count or a quantifier ("every", "all", "each", "never", "no longer") is run before it is written, and the line carries the number you got. The wording that survives is narrower and duller than the first draft: "the diff against `<sha>` is empty" is wrong when it is only empty under a path restriction, and "each case asserts X" is wrong when one case does not.

A cause is not a fact just because the state change is. Timeline, exit codes and greps establish state; attribution needs an audit trail. A line that explains **why** something happened is split: the verified state change in the indicative, the cause marked as a hypothesis with the evidence that would settle it. "Ruled out X and Y, cause unknown" beats a plausible culprit.

Every stage that follows reads a declaration as settled and stops looking, so an unverified line is worse than none.

## Append as the decision is taken

Not at the end, when the reason has gone fuzzy. One line each for:

- a test pointed at live data instead of a frozen fixture,
- a collaborator kept real against the repo's documented mocking rule,
- an AC measure substituted for an unreachable one — both numbers in the line,
- a fixture large enough to argue about,
- a local idiom followed over the documented one,
- a decision the owner agreed after the ticket was written,
- anything you would otherwise explain in the PR description.

The reason still goes where the code lives — that comment is for the next reader, the ledger line is for this review.

## Read it into the review — both agents, nothing pasted by hand

Read the ledger before dispatching any review. Absent, and `git ls-files '*decisions/<TICKET>.md'` finds nothing either → say so in one line and run the review exactly as it runs without a ledger.

The review skills already expose the slots. This skill fills them from the file instead of from memory:

| Review | Slot it already has | Lines that go in |
|---|---|---|
| flow-code-review | Step 2's spec addenda → the Spec brief's "Agreed after the ticket" | `spec`, `both` |
| flow-code-review | Step 3's pre-declared deviations → the Standards brief's "Deliberate deviations" | `standards`, `both` |
| flow-confidence-check | a `Declared decisions (author-written, from the branch's ledger)` block appended to every dimension-agent prompt, under the learnings block | all of them, tags kept |

Paste the lines verbatim, tag included. **The review skills are never edited to carry the ledger** — their existing slots are enough, and a teammate with no ledger must lose nothing.

## What a declared line does, and does not do

- A `spec` line is binding like the ticket: work implementing it is not scope creep, and skipping it is a missing requirement rather than a judgement call.
- A `standards` line is graded, not obeyed: the agent judges whether the decision is sound and documented where the code lives, instead of spending its strongest finding rediscovering it.
- A line ending in `self` is the author's own judgement, not an authority — an agent that thinks it is wrong says so.
- A declared deviation never lowers the severity of a genuine defect, and never refutes a finding on its own. To flow-confidence-check's adversarial verifier a ledger line is author-supplied context, exactly like a code comment.
- The ledger is not a suppression list — that is the repo's review-learnings file — and not a spec source: flow-confidence-check's Phase 1 cascade resolves the spec on its own, and the ledger only extends it. Editing a ledger line changes what the reviews see, so a `no-op` fast path that has not seen the current file is stale; force a full run after a ledger edit.

## Done when

Every decision taken this session is one line ✓ every review dispatched this session got the matching lines in its brief ✓ the ledger is committed with the change ✓
