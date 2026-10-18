# flow-tdd

The test-first implementation loop, between `flow-start-ticket` (which agrees the plan) and `flow-code-review` / `flow-create-commit` (which close it). Beyond red → green, it carries what a generic TDD reference leaves out:

1. Discover the repo's test levels and its gates - green means "rubocop and typecheck pass", not just "the assertion passes".
2. Restate the seam table (seam / level / mode / deliberately not tested) inherited from the agreed plan instead of re-negotiating seams mid-loop. Only a seam the plan never named needs confirming.
3. Probe before the first red - a required throwaway replay of real data whenever an acceptance criterion carries a number or the inputs can't be hand-authored. It reproduces the ticket's numbers and picks the fixture. Three outcomes: the numbers reproduce, and the probe becomes the test's skeleton; they don't, and the ticket is corrected first; the target is unreachable, and the strongest true measure is substituted, with both numbers recorded.
4. Pick the loop mode per seam: vertical slices where the next cycle can still change the design, the whole spec set up front where the cases are enumerable from a written contract.
5. Red → green with an honest red (it fails on the assertion), expected values from an independent source of truth, and the computation the assertion depends on left unmocked.
6. Pin the behaviour the change claims not to alter - for a bug fix, one red plus a pin set.
7. Bound the blast radius when an acceptance criterion says "X is unchanged": a green suite only proves nothing asserted moved.
8. Prove green, then report what the suite cannot say. Green is a `verify-claim` re-run of the profile's test command at the committed SHA, with every gate's exit code and output tail pasted; then come the acceptance criteria that need a human, a physical device, or a document.

## Install

```bash
./install.sh flow-tdd
```

Then restart Claude Code (or start a new session). No configuration - the skill learns each repo from its own docs every run.

## Usage

```
/flow-tdd
"implement step 2 test-first"
"TDD the validator"
"write the regression test for ABC-208 first"
```

Best invoked with a plan already agreed (`flow-start-ticket` step 5): the plan's per-step test levels become the seam table, so the loop runs without interruptions.

## Reference files

| File | When it is read |
|---|---|
| `references/test-quality.md` | Anti-patterns (including *selection-tautological*), where expected values come from, the mocking rank rule, fixture rules, pins. |
| `references/seam-modes.md` | The seam is not a plain function: an extraction, a build artifact, a CI job, a dependency's type contract, a persisted format, behaviour across two layers, a UI component. |
| `references/harness-traps.md` | The first red looks wrong: jsdom gaps, animation, pooled events, a stale `dist/` or `node_modules`, plus the recipe for re-verifying the red at the end. |

## Requirements

- `git` (Step 4's red re-verification and Step 6's blast-radius diff both use `git stash`)
- The repo's own testing docs - undocumented essentials are asked about, then offered as a `CLAUDE.md` addition

## Provenance

Every rule is traceable to a session where its absence cost time. The provenance notes cite private session records, so they are kept outside this repository; read them before changing a rule.
