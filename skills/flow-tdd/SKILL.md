---
name: flow-tdd
description: Drive a ticket's implementation test-first - inherit the seam table from the agreed plan, probe before the first red, run red-green at the level the repo's own conventions ask for, pin the behaviour the change must not alter, and bound the blast radius. Use when the user says "implement this test-first", "TDD this", "red-green", "write the test first", "let's do ABC-1234 with tests", when a bugfix needs a regression test, or when a plan's steps name test levels.
user-invocable: true
---

# flow-tdd

## Step −1 — Resolve the project profile

Read `$TILLER_HOME/skills/_shared/resolve-profile.md` and follow it; no profile resolves → stop.

The red → green loop as it actually runs on real tickets: on tickets whose acceptance criteria carry numbers, in repos where a linter is a merge gate, against seams that are sometimes a build artifact instead of a function, and on changes whose second criterion is "nothing else moved".

`references/test-quality.md` defines what a test worth keeping looks like (anti-patterns, expected values, mocking, fixtures).
`references/seam-modes.md` carries the playbook for a seam that is not a plain function call.
`references/harness-traps.md` is for when a red is not the red you think it is.

## Step 0 — Discover the repo's gates and testing conventions

Read the repo's own docs (`CLAUDE.md`/`AGENTS.md` and everything they link, README, CONTRIBUTING, testing docs, ADRs in the area you touch). Capture, in writing:

- the **test levels** this repo names (unit / request / component / e2e / replay), and the command to run **one file** at each,
- the **gates** CI runs — typecheck, lint, formatter, complexity cops. These decide what "green" means in Step 4,
- the repo's own testing rules: mocking conventions, determinism rules ("never assert against real time"), where fixtures live, whether unit tests may touch disk,
- the **widest deterministic report** the repo owns (a replay over a corpus, an accuracy check, a generated inventory) — Step 6 needs it,
- the domain vocabulary, so test names read in the project's language.

Something essential is undocumented → ask, then offer to record the answer in the repo's `CLAUDE.md`. This skill carries no per-repo config.

## Step 1 — Restate the seam table

**The seam list arrives; it is not negotiated here.** The plan agreed in flow-start-ticket (or any plan the user approved) already names the seams and the test level per step. Restate it as a table before the first test:

| seam | test level | loop mode (Step 3) | deliberately not tested here |
|---|---|---|---|

The last column is the load-bearing one: it records the negative decisions — no e2e for a read-only listing, the component's React internals, the 1200-line page's render body — so review reads a decision instead of a hole.

Ask the user to confirm **only** a seam the plan did not name. Extending a module that already carries a test file inherits its seams by rule; restate them in two lines and move on.

Two more things belong in this step:

- **Logic reachable only through the DOM (or only inside a render body / callback) is a seam problem, not a test problem.** Extract it as a pure function with one call site, then test the function. A heavy DOM-only test file is the fallback, never the default.
- **Inherited does not mean unchecked: before writing a row's test, confirm the named level can actually observe the rule.** The seam list is not renegotiated, but a plan naming a *file* can name one where the assertion cannot fail — the guard under test sits behind an outer guard that fires first, the harness owns that directory, the value the rule turns on never reaches that layer. Check it against the code, not against the plan's confidence. When the level is blind to the rule, that is the DOM case above wearing different clothes: extract the decision to where it is observable (a component taking the id instead of reading the router, a predicate taking the state instead of the query), keep the plan's original level as a mount-it-for-real test so nothing is traded away, and put the substitution in the ledger as a deviation from the agreed seam table. Writing the test where the plan pointed and watching it pass is the failure mode — it reads as coverage of a rule nothing holds.
- **Before writing the file, check what its directory costs — a test's location can change who is allowed to merge the branch.** Choosing where a test lives normally trades off harness reuse against duplication, and that is the whole decision in most repos. It is not the whole decision in a regulated one: a repository can gate specific paths behind a named human signature, and those paths do not announce themselves — they are usually described by what the *shipping* code in them does, so a test file feels exempt. It is not, because the gate is path-based on purpose. So before creating a test file (and again before moving one), read the repo's merge-authority rules against the **directory you are about to write into**, not against the code you are testing, and say in the report if the branch's merge path changed. Two corollaries: never derive an exemption from the file being "only a test" or "offline tooling" — that generalisation is what merges a change into a signature path unsigned; and when reuse and merge path pull in opposite directions, that is a trade for the branch's owner, presented with both costs, not one you settle inside the loop.
- **Name the acceptance criteria no test level can reach**, in two classes:
  - *unobservable* — needs hardware, a physical device, a browser session, or a person performing the action;
  - *non-behavioural* — a document, a version policy, a naming convention, a contract "agreed with" another team.

  Both travel to Step 7 as explicit human-verification items. A green suite never stands in for either. The non-behavioural class is the easy one to tick off silently, because writing the doc feels like progress.

## The deviation ledger — one line, the moment you deviate

Every review that follows reads the branch's ledger, at the path the profile's `## decision ledger` section names (ticket key from the branch name; no key → the branch slug). Append the line as the decision is taken, not at the end when the reason has gone fuzzy:

```
- 2026-07-28 · standards · the dataset test imports the live validation set instead of a frozen `__fixtures__` copy — catching a dataset change that breaks setup is the point of the test · self
```

Grammar: `- <YYYY-MM-DD> · <spec|standards|both> · <decision> — <why> · <agreed with <who>, <where> | self>`. Field 2 routes the line: `standards` reaches the reviewer reading conventions, `spec` the one reading the ticket, `both` reaches both. No file yet → create it with a `# <TICKET> — decision ledger` header. It is committed with the change.

One line each for: a test pointed at live data instead of a frozen fixture · a collaborator kept real against the repo's mocking rule · an AC measure substituted for an unreachable one · a fixture big enough to argue about · a local idiom followed over the documented one · anything you would otherwise explain in the PR description.

The reason still gets written where the code lives — that comment is for the next reader, the ledger line is for this review. Undeclared, a review spends its strongest finding rediscovering a decision you already made; declared, it grades the decision instead.

## Step 2 — Probe before the first red

A **probe** is a throwaway script or test that replays real inputs through the shape you intend to build and **prints what happened**. It asserts nothing, so it is neither red nor green. It costs minutes; it validates the approach, selects the fixture, reproduces the ticket's measured numbers, and can *falsify the ticket's own acceptance criterion* before a line of test code exists.

**The probe is a required step, not a flourish,** whenever any of these holds:

- the ticket's acceptance criteria carry numbers ("0 of 153 records rejected", "at least 1500 ms", "±1 item"),
- the task is an extraction whose criterion is parity with the code it came from,
- believable inputs cannot be hand-authored (captured traffic, recordings, real corpora),
- you would otherwise be guessing whether a test *can* go green.

Replay **every** available real input, not one. The spread across the corpus is what exposes an unreachable threshold, and the mismatches usually have explanations worth knowing before a test depends on them (a reference value changed after the data was captured). Then read the output against the ticket — exactly four things can come back:

1. **The ticket's numbers reproduce.** The probe's output is the regression test's skeleton, and it has already chosen the fixture: freeze a trimmed copy when the test guards an algorithm, point at the live corpus when it guards the data (`references/test-quality.md`).
2. **They do not reproduce.** The premise is stale, not the probe — never tune the probe until it matches. Stop, say which claim is false, and treat the corrected ticket as the next deliverable (back out to flow-plan-ticket, rewrite via flow-write-ticket). A probe that will not run at all is a different problem: `references/harness-traps.md`.
3. **The numbers reproduce but the ticket's target is unreachable from the available data.** **Measure before you assert:** neither chase the number nor quietly relax the assertion. State both measurements, substitute the strongest measure that is *true* and still catches the bug, put the numbers on both sides of the substitution in the test's own comment, and carry it into the PR (Step 7). An AC can be perfectly observable and simply over-specified.

4. **The probe ran and cannot answer the question** — the platform reports success whether or not the thing happened. A macOS `display notification` exits 0 when the OS silently suppresses it for lack of permission; the same holds for a fire-and-forget webhook, a push, an email hand-off. Do not read exit 0 as delivery, and do not build an assertion on top of it: the test would be green forever. Split the seam instead — unit-test the *decision* (which notification, when, how often, what it says) against injected time and state, and treat *delivery* as a Step 7 human-verification item. Then owe the product a runtime symptom for the same reason, because a channel that dies silently is exactly what a green suite will not tell you: a visible trace of the last successful send, and a way to trigger one on demand through the real caller (a menu item, a CLI flag), since the permission usually belongs to the launching app rather than to your code.

**The probe stays throwaway.** What survives it is the numbers — in the test's comment and in the Step 7 report, where they are the evidence that the later red is the ticket's red. Write the real test in the repo's own test conventions and delete the probe; a scratch script decorated with assertions is not the regression test.

## Step 3 — Pick the loop mode per seam

One question decides it: **can cycle N+1 teach me anything cycle N didn't?**

- **Yes → vertical slices.** One test → the minimal implementation that passes it → repeat, each test a tracer bullet responding to what the last cycle taught. This is the mode for unknown design: new modules, wiring, naming, anything where slice 1 changes slice 2's shape.
- **No → write the spec set up front,** one red, one green. This is the mode when the branches are independent and enumerable from a written contract: validators, mappers, pure formatters, presentational components with N render branches. Slicing an 18-branch validator produces 18 artificial cycles and zero design feedback.

State the chosen mode in the seam table so a reviewer can disagree with it.

A seam that is not a plain function call — an extraction, a build artifact, a CI job, a dependency's type contract, a persisted format, behaviour observable only across two layers — has its own playbook in `references/seam-modes.md`. Read it before the first red for that seam.

## Step 4 — Red → green

Writing the test:

1. **The red is honest: the test fails on its assertion, for the reason the ticket describes.** A failure to mount, a missing browser API or a stale build artifact is a false red. Example: `references/harness-traps.md` names the recurring ones and how to clear them.
2. **Expected values come from an independent source of truth** — a hand-worked example, the format's definition, the spec, the other side's contract — never from re-running or re-computing the new code (`references/test-quality.md`). Example: assert a client filename against the server's whitelist regex.
3. **A regression test over a pipeline records which stage rejected, not just a count,** so a future red reads as a diagnosis. Example: `schema check (need v2, got v1)`.
4. **A collaborator that computes the value under assertion stays real**, whatever the repo's mocking convention. Example: stub it — if the test can no longer fail for the ticket's reason, keep it real and write that reason into the test file.
5. **Green means the repo's gates pass, not the assertion.** Restructuring a gate forces is part of green; discretionary cleanups belong to review. Example: a function decomposed because the complexity cop rejected it.
6. **An awkward test is design feedback.** Example: a test that needs fake timers asks first whether the code needs the clock at all — deriving the value from data in hand removes the nondeterminism from production too.

Proving the red, before leaving this step:

7. **Re-verify the red by reverting only the implementation files.** Every test you believe is red must go red for its stated reason; one that stays green is a pin and is relabelled in Step 5. Example: an assertion that was green all along shows up here and nowhere else.
8. **For a new module, revert against the plan's version, not against nothing.** Copy the plan's proposed implementation and the test file into a scratch directory and run them together: what fails is the red your work earned, what passes is a pin. Example: deleting the new file only produces `ModuleNotFoundError`, which measures nothing.
9. **When neither revert exists, mutate one rule at a time.** Break each rule the change encodes, run the suite, and report which tests went red per rule; green under a mutation is a test that never tested that rule. Example: `dropping the empty-scan guard reddens 1, collapsing escape into corpus reddens 3`.
10. **Mutate every input a check covers, and report the count.** One mutation measures one member; in a loop over a list the others run through the same code, so they are covered only by being mutated too. Example: a check that searches a whole document for seven field names stays green for `type` and `items` when the real field is renamed, because those words occur everywhere — `8 mutations, 8 caught` is the report shape.
11. **Mutate the smallest unit that can drift on its own — an endpoint, a file, a row — not the name.** An existential check ("some schema has this field") reddens on a document-wide rename and stays green when one site drops it. Where the check has no per-unit denominator, single-unit drift is undetectable by construction: say so as a numbered residual in the Step 7 report and the ledger. Example: `5 scoped mutations, 0 caught, no per-path denominator exists`.
12. **A finding that names several sites closes only when each site is measured.** Re-read its text for every file, function and call site it names and record a measurement per site; where two sites implement one rule, share the rule instead of repairing both copies. Example: a guard added to the reading path, bypassed by the extraction path that persisted the same value.
13. **A comment that asserts a rule is a mutation site.** Read the diff's rationale comments as a checklist; each one gets a test that goes red under its own mutation. Example: "a set rather than one slot, because a second registration would silently unregister the first".
14. **A negative assertion is only as strong as the narrowest fixture that satisfies it.** For each `not.toContain`, empty-warnings or "catch-all did not fire" assertion, name which movement in the fixture satisfies it; if it is not the rule under test, take that movement out, and comment on a deliberately inconsistent fixture so nobody "fixes" it. Example: a totals line, moved only to keep the fixture self-consistent, was what suppressed the catch-all.

## Step 5 — Pin the preserved behaviour

Add one **pin** — a test that is green on arrival by design — per behaviour the change claims *not* to alter, with the pin named or commented as such. Pins exist so that deleting or weakening preserved behaviour fails the suite; they are where much of the review value sits, because they are what stops a later change from quietly reverting this one.

- **Bug fixes invert the ratio.** Exactly one test can legitimately be red — the regression test for the reported scenario. Everything a correct fix opens up (the new aggregate's arithmetic, the null case, the fall-back) can only be a pin.
- A correct small implementation legitimately satisfies several specs at once. That is a signal to stop adding cycles, not to manufacture reds.
- Checklist before leaving this step: **every arm or branch of a multi-arm rule is reachable by exactly one test** — including the arm that fires alone, and the exact-boundary case.
- **Before changing a rule, find the tests that already assert it — a pin you break is a decision this repo already took.** Choosing between two candidate rules on their merits is not enough, because the merits are what somebody already weighed when they wrote the pin; two rules measured identical over a whole corpus can still contradict a pin that encodes the opposite for a reason the measurement does not see. Cheap check, and it is a grep not a judgement: search the repo for tests naming the behaviour you are about to invert *before* you implement, not after the suite goes red. Where the pin turns out to be wrong, that is a finding to raise, not a test to update in passing.
- **Changing what a shared fixture resolves to can make other tests vacuous instead of red — and vacuous tests do not fail.** Example: a fixture that stops exercising a fallback leaves the pin "the fallback is chosen once, at construction" passing without touching the path it claims to pin, and every mutation runs through the same dead path. So after you change a fixture's resolution, enumerate the tests that depended on it and ask of each one *can this still fail?* — not *does this still pass?* The tell is a test whose subject is a behaviour the fixture no longer exhibits.
- **A change that narrows a filter must apply its new floor *inside* the existing veto, not after it — and the pin for that is a fixture where the veto and the floor disagree.** Example: computing `allowed ∩ visible` and then adding the mandatory fields unconditionally one line later keeps every existing test green as long as each fixture has the mandatory fields visible; the defect appears only when one is not. So whenever a diff adds a floor, a default, an "always include" or a fall-back next to an existing filter: write the pin where the two rules point in opposite directions, and state the composed rule in one line (`(allowed ∪ mandatory) ∩ visible`) — if the code and that line disagree, the code is wrong.

## Step 6 — Bound the blast radius

Trigger: an acceptance criterion phrased as "**X is unchanged**", or any change inside a shared numeric, scoring, or otherwise derived pipeline.

A fully green suite cannot answer "what else moved?" — it only proves that nothing *asserted* moved. Bound it mechanically:

1. `git stash` the changed files (or run the pre-change side in a second worktree),
2. run the repo's widest deterministic report from Step 0 over its whole corpus,
3. restore, run it again,
4. diff the two outputs.

Report the result as a number: which fields moved, which did not (e.g. "32 lines changed, every one a `signed` inside a rejection detail; no verdict, count, reason or channel moved"). That diff, not the suite, is the evidence for the criterion.

## Step 7 — Prove green, then report what the suite cannot say

**Green is a measurement, not a statement.** Before the report says green:

1. Commit the change (flow-create-commit), so the tree is clean at one SHA.
2. Re-run the profile's test command at that SHA, from the worktree:

   ```bash
   node "$TILLER_HOME/lib/resilience/verify-claim.mjs" <profile.md> <repo> pass --cwd "$PWD" --expect-sha "$(git rev-parse HEAD)"
   ```

   `<repo>` is the repo's short name as the profile's `## test toolchain` table keys it. Repeat once per `## static checks` row with `--section "static checks"` and the row's Check as the match.
3. Read the JSON line. Green is `"status":"ok"`, `"actual":"pass"`, `"mismatch":false`. `blocked` (dirty tree, wrong SHA, no runnable command) is **not verified** — report it with its `reason`, never as green. `"actual":"fail"` is red: back to Step 4.

Close with:

- the seam table as executed — level, mode, and the deliberate negatives,
- pins listed as pins,
- the probe's numbers when one ran — what reproduced, and what the corpus actually reaches — as the baseline the red was judged against,
- any AC measure you substituted, with the numbers on both sides of the substitution,
- the unreachable ACs from Step 1 as explicit human-verification steps (hardware/human, and document/policy),
- the blast-radius diff summary, when Step 6 ran,
- per gate you ran: the command, its exit code, and the last lines of its output (at most 10), pasted verbatim — a gate with no pasted output is reported as *not run*,
- each verify-claim JSON line, pasted verbatim, with the SHA it ran at.

## Done when

A probe ran wherever Step 2 required one, and its numbers are in the report ✓ every seam in the table is red→green or pinned ✓ the red was re-verified honest by reverting the implementation ✓ every gate the repo runs in CI has its exit code and output tail pasted in the report ✓ verify-claim returned `ok` / `pass` at the reported SHA for the test command and every static check ✓ unreachable ACs named as human-verification items ✓ every deliberate deviation is a line in the ledger ✓

## What this skill does NOT do

- Choose the plan, the branch, or the seams (flow-start-ticket).
- Review style, architecture, or diff-vs-spec (flow-code-review), or issue a pre-merge verdict (flow-confidence-check).
- Write commit messages or open a PR (flow-create-commit, flow-create-pull-request) — Step 7 calls flow-create-commit so verify-claim has a clean SHA to run at.
- Discretionary refactoring — only restructuring a gate forces happens inside the loop.
