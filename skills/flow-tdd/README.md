# flow-tdd

The implementation loop, test-first, between `flow-start-ticket` (which agrees the plan) and `flow-code-review` / `flow-create-commit` (which close it).

Red → green is the easy part. What this skill carries is everything that turned out to be load-bearing on real tickets and is missing from a generic TDD reference:

1. **Discover** the repo's test levels and — crucially — its **gates**, because green means "rubocop and typecheck pass", not "the assertion passes".
2. **Restate the seam table** (seam / level / mode / *deliberately not tested*) inherited from the agreed plan, instead of re-negotiating seams mid-loop. Only a seam the plan never named needs confirming.
3. **Probe before the first red** — a *required* throwaway replay of real data whenever an AC carries a number or the inputs can't be hand-authored. It reproduces the ticket's numbers, picks the fixture, and once falsified a ticket's own acceptance criterion (an unreachable threshold) before any test was written. Three outcomes, each with its own exit: numbers reproduce → the probe is the test's skeleton; they don't → the premise is false and the ticket is corrected first; the target is unreachable → substitute the strongest measure that is true, with both numbers recorded.
4. **Pick the loop mode per seam**: vertical slices where the next cycle can still change the design, the whole spec set up front where 18 validator branches are enumerable from a written contract.
5. **Red → green** with an honest red (it fails on the *assertion*), expected values from an independent source of truth, and the computation that the assertion depends on left unmocked.
6. **Pin** the behaviour the change claims not to alter — for a bug fix that is one red plus a pin set, not the other way round.
7. **Bound the blast radius** when an AC says "X is unchanged": a green suite only proves nothing *asserted* moved.
8. **Prove green, then report what the suite cannot say** — green is a `verify-claim` re-run of the profile's test command at the committed SHA, with every gate's exit code and output tail pasted; then the acceptance criteria that need a human, a physical device, or a document.

## Install

```bash
./install.sh flow-tdd
```

Then restart Claude Code (or start a new session). No configuration — the skill carries no per-repo config and learns each repo from its own docs every run.

## Usage

```
/flow-tdd
"implement step 2 test-first"
"TDD the validator"
"write the regression test for ABC-208 first"
```

Best invoked with a plan already agreed (`flow-start-ticket` step 5) — the plan's per-step test levels become the seam table, which is why the loop then runs without interruptions.

## Reference files

| File | When it is read |
|---|---|
| `references/test-quality.md` | Anti-patterns (including *selection-tautological*), where expected values come from, the mocking rank rule, fixture rules, pins. |
| `references/seam-modes.md` | The seam is not a plain function: an extraction, a build artifact, a CI job, a dependency's type contract, a persisted format, behaviour across two layers, a UI component. |
| `references/harness-traps.md` | The first red looks wrong: jsdom gaps, animation, pooled events, a stale `dist/` or `node_modules`, plus the recipe for re-verifying the red at the end. |

## Requirements

- `git` (Step 4's red re-verification and Step 6's blast-radius diff both use `git stash`)
- The repo's own testing docs — undocumented essentials are asked about, then offered as a `CLAUDE.md` addition

## Provenance

Every rule is traceable to a session where its absence cost time. The provenance notes cite private session records, so they are kept outside this repository; read them before changing a rule.
