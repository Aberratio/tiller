---
name: flow-tdd
description: Drive a ticket's implementation test-first - inherit the seam table from the agreed plan, probe before the first red, run red-green at the level the repo's own conventions ask for, pin the behaviour the change must not alter, and bound the blast radius. Use when the user says "implement this test-first", "TDD this", "red-green", "write the test first", "let's do ABC-1234 with tests", when a bugfix needs a regression test, or when a plan's steps name test levels.
user-invocable: true
---

# flow-tdd

## Step −1 — Resolve the project profile (before anything else)

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .        # prints the profile file; non-zero means stop
```

Read the profile it names. Every project-specific fact this skill needs — tracker and project key, main branch,
branch convention, worktree procedure, ledger path, merge authority, environments, test commands,
gates — comes from there and from nowhere else.

**No profile resolves → stop and say so.** Do not fall back to the project you saw last. Applying
one project's merge rule or test command to another is the failure this whole mechanism exists to
prevent.

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
  - *unobservable* — needs hardware, a camera, a browser session, or a human performing the movement;
  - *non-behavioural* — a document, a version policy, a naming convention, a contract "agreed with" another team.

  Both travel to Step 7 as explicit human-verification items. A green suite never stands in for either. The non-behavioural class is the easy one to tick off silently, because writing the doc feels like progress.

## The deviation ledger — one line, the moment you deviate

Every review that follows reads the branch's ledger, at the path the profile's `## decision ledger` section names (ticket key from the branch name; no key → the branch slug). Append the line as the decision is taken, not at the end when the reason has gone fuzzy:

```
- 2026-07-28 · standards · the corpus test imports the live validation set instead of a frozen `__fixtures__` copy — catching a corpus retune that breaks setup is the point of the test · self
```

Grammar: `- <YYYY-MM-DD> · <spec|standards|both> · <decision> — <why> · <agreed with <who>, <where> | self>`. Field 2 routes the line: `standards` reaches the reviewer reading conventions, `spec` the one reading the ticket, `both` reaches both. No file yet → create it with a `# <TICKET> — decision ledger` header. It is committed with the change.

One line each for: a test pointed at live data instead of a frozen fixture · a collaborator kept real against the repo's mocking rule · an AC measure substituted for an unreachable one · a fixture big enough to argue about · a local idiom followed over the documented one · anything you would otherwise explain in the PR description.

The reason still gets written where the code lives — that comment is for the next reader, the ledger line is for this review. Undeclared, a review spends its strongest finding rediscovering a decision you already made; declared, it grades the decision instead.

## Step 2 — Probe before the first red

A **probe** is a throwaway script or test that replays real inputs through the shape you intend to build and **prints what happened**. It asserts nothing, so it is neither red nor green. It costs minutes, and across three sessions running it has been the highest-return step of the loop: it validated the approach, selected the fixture, reproduced the ticket's measured numbers, and once *falsified the ticket's own acceptance criterion* before a line of test code existed.

**The probe is a required step, not a flourish,** whenever any of these holds:

- the ticket's acceptance criteria carry numbers ("0 of 153 frames", "at least 1500 ms", "±1 rep"),
- the task is an extraction whose criterion is parity with the code it came from,
- believable inputs cannot be hand-authored (motion data, recordings, real corpora),
- you would otherwise be guessing whether a test *can* go green.

Replay **every** available real input, not one. The spread across the corpus is what exposes an unreachable threshold, and the mismatches usually have explanations worth knowing before a test depends on them (a reference retuned after capture). Then read the output against the ticket — exactly four things can come back:

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

**Honest red.** The test must fail on its **assertion**, for the reason the ticket describes. A failure to mount, a missing browser API, or a stale build artifact is a false red — `references/harness-traps.md` names the recurring ones and how to clear them before trusting the failure.

- Expected values come from an **independent source of truth**: a hand-worked example, the format's own definition, the spec, the *other* side's contract (assert a client filename against the server's whitelist regex). Never from re-running the new code, never recomputed the way the code computes it. See `references/test-quality.md`.
- A regression test over a pipeline records **which stage rejected**, not just a count (`orientation (need upright_back, detected upright_front)`), so a future red reads as a diagnosis.
- A collaborator that **computes the value under assertion stays real**, however internal the repo convention says it is. The test: replace it with a stub — can the test still fail for the reason the ticket describes? If no, keep it real, and write that reason into the test file when it deviates from the repo's documented mocking rule.
- **Green means the repo's gates pass**, not that the assertion passes. Restructuring the linter forces (a function decomposed because a complexity cop rejected it) is part of achieving green. Discretionary "extract a helper for readability" cleanups still belong to review.
- **An awkward test is design feedback.** When only fake timers or a seeded RNG can make it deterministic, first ask whether the code under test needs to read the clock or the RNG at all — deriving the value from data already in hand usually removes the nondeterminism from production, not just from the test.

**Re-verify the red at the end.** Revert only the implementation file(s), re-run, and check that every test you believe is red goes red for its stated reason. Tests that stay green are pins — relabel them in Step 5. This catches the assertion that was green all along.

**When the module is new, revert against the plan's version, not against nothing.** Deleting a brand-new file makes every test in it fail on `ModuleNotFoundError`, which measures nothing: an import error is not the ticket's red, and it hides how many of your assertions the *obvious* implementation would already have satisfied. When the plan (or the ticket, or the upstream skill) hands you a proposed implementation, copy it verbatim into a scratch directory next to a copy of the test file and run them against each other. What fails there is the genuine red your work earned; what passes is a pin, and belongs in Step 5 and the Step 7 report labelled as one. Do this before writing your own version if the proposed one is short — the split it produces is also the shortest honest answer to "was this change necessary?".

**When neither revert is available, mutate one rule at a time instead.** A review finding that dictates the implementation's shape ("move this scan into a script"), or any task where the destination is specified and there is no plan version to diff against, leaves you writing implementation first — and then both reverts measure nothing. Recover the honest red per *rule* rather than per file: break each rule the change encodes, one at a time, run the suite, and record which tests go red for each. Green under a mutation is a test that was never testing that rule. Report the map (`dropping the v2 classification reddens 2 tests, collapsing escape into corpus reddens 3, dropping the empty-scan guard 1`) — it is stronger evidence than a single up-front red, because it names which assertion holds which rule, and it is the only honest red available for an absence-asserting check whose subject is always clean in the repository.

**One mutation per *input the rule covers*, not one per rule.** Where a single check runs over N names, fields, paths or files, mutating one of them measures that one and nothing else — and a pass there reads as though the whole check works. On ABC-223 a contract gate asserted seven field names against an OpenAPI document; mutating `nextPageToken` went red, so the check was reported as holding. It did not: `items` is also OpenAPI's own array-schema keyword (60 occurrences in that document), `type` is on every schema node (812), `title` is also `info.title`, and a whole-document search for those four **could not fail** — renaming the real envelope key left the gate green. Four of the seven were unpinned, and the one mutation that passed was the one field that happened to be unique. So: enumerate what the check covers, mutate **every** member, and put the count in the report (`8 mutations, 8 caught`). A single green mutation generalises to the others only when they are checked by different code — which, in a loop over a list, they never are.

**And mutate at the granularity of the smallest thing that can drift on its own, not at the granularity of the name.** Enumerating members is only half of it: a check phrased "*some* schema requires these fields" is existential over every occurrence in the document, so renaming the field *everywhere* reddens it while dropping it from **one** endpoint does not. Re-measured on ABC-223, after the rule above had already been applied: all 7 declared field names went red under a document-wide rename (24/24 including every declared path), and 5 of those 7 stayed **green** when the field was removed from exactly one of the 41 schemas carrying it — the paging envelope was the only shape that caught it, because a review finding had already given that one a *denominator* (the frontend declares which of its paths answer a list, so the check counts groups instead of asking whether any exists). So: ask what the drift unit is — an endpoint, a file, a row, a workflow job — and mutate one of those, not one of the names. Where the check has no denominator to count against, single-unit drift is undetectable **by construction**: say so as a numbered residual in the Step 7 report and in the ledger (`5 scoped mutations, 0 caught, no per-path denominator exists`) rather than leaving the count from the name-level pass to imply the check is whole.

**A finding that names more than one site is not closed until every site is measured.** A written finding is a claim about a set, and the set is usually stated in its own text — "the signal path answers first *and* `schema.js` bakes the same answer into newly extracted references". Fixing the site you happened to read first and closing the finding leaves the defect alive through the other one, and the suite cannot tell you, because the half you fixed is the half your tests now cover. Measured on ABC-226: a guard added to the *reading* path was bypassed at the *extraction* path, which persisted the same value where it was later read back as authoritative and trusted — both halves had been named in the branch's own decision ledger eight days earlier, and only one was implemented. So before closing a finding, re-read its text for every file, function or call site it names, and record a measurement per site. Where two sites implement one rule, the fix is usually to share the rule rather than to repair both copies — two copies of a precedence is how the hole existed in the first place.

**A comment that asserts a rule is a mutation site.** Where the code explains why it is shaped this way — "a set rather than one slot, because a second registration would silently unregister the first" — the sentence is a specification somebody wrote instead of a test. On ABC-223 all three unheld rules in the frontend layer were of exactly this form (a second session-loss subscriber being silenced, a defaulted `links` extension, an id dropped from a cache key), each cost one short test, and each went red under its own mutation and nothing else. So read the diff's *rationale* comments as a checklist before leaving Step 4.

**A negative assertion is only as strong as the narrowest fixture that satisfies it.** "Nothing else was said" — `not.toContain`, `expect(warnings).toEqual([])`, "the catch-all did not fire" — is usually the assertion carrying the ticket, because the reported defect is that the *wrong* thing got said. It is also the one a generous fixture silently satisfies for the wrong reason: when a crafted input moves more than the rule under test, some *other* line can be what keeps the forbidden output away, and the test then passes with the rule under test deleted. Mutation catches it only if you happen to mutate that rule, so check it directly instead — for each negative assertion, name which movement in the fixture satisfies it, and if the answer is not the rule under test, take the extra movement out. On ABC-216 both distractor fixtures started out internally consistent (a clip added to the baseline, and `totals.phantom_clips.clips` moved to match); the totals line that consistency produced was what suppressed the catch-all, not the distractor line under test. Dropping the totals movement left the fixtures inconsistent with their own aggregates — the right trade, because self-consistency was not what the criterion was about. Where an inconsistent fixture is the stronger one, say so in a comment: the next reader's instinct is to "fix" it.

## Step 5 — Pin the preserved behaviour

Add one **pin** — a test that is green on arrival by design — per behaviour the change claims *not* to alter, with the pin named or commented as such. Pins exist so that deleting or weakening preserved behaviour fails the suite; they are where much of the review value sits, because they are what stops a later change from quietly reverting this one.

- **Bug fixes invert the ratio.** Exactly one test can legitimately be red — the regression test for the reported scenario. Everything a correct fix opens up (the new aggregate's arithmetic, the null case, the fall-back) can only be a pin.
- A correct small implementation legitimately satisfies several specs at once. That is a signal to stop adding cycles, not to manufacture reds.
- Checklist before leaving this step: **every arm or branch of a multi-arm rule is reachable by exactly one test** — including the arm that fires alone, and the exact-boundary case.
- **Before changing a rule, find the tests that already assert it — a pin you break is a decision this repo already took.** Choosing between two candidate rules on their merits is not enough, because the merits are exactly what somebody already weighed when they wrote the pin. On ABC-226 two rules for resolving a reference's working side were measured as *identical over the whole corpus*, so the choice was made on principle — measurement beats a naming convention — and it silently contradicted `schema.test.js`'s pin "does not let the excursions overrule it", which encodes the opposite and had a reason: naming the cycle signal is the author's statement about the movement, while the excursions are one demonstrator's performance of it. Cheap check, and it is a grep not a judgement: search the repo for tests naming the behaviour you are about to invert *before* you implement, not after the suite goes red. Where the pin turns out to be wrong, that is a finding to raise, not a test to update in passing.
- **Changing what a shared fixture resolves to can make other tests vacuous instead of red — and vacuous tests do not fail.** Same branch, same day: making a fixture stop resolving to a working side left a pin asserting "the mirror is chosen once, at construction" running against an engine that no longer mirrors at all. It passed without touching the path it claimed to pin, and the mutation pass could not see it because every mutation ran through the same dead path. So after you change a fixture's resolution, enumerate the tests that depended on it and ask of each one *can this still fail?* — not *does this still pass?* The tell is a test whose subject is a behaviour the fixture no longer exhibits.
- **A change that narrows a filter must apply its new floor *inside* the existing veto, not after it — and the pin for that is a fixture where the veto and the floor disagree.** On ABC-213 the narrowing computed `judged ∩ confidently_seen` and then added the torso landmarks unconditionally, one line later. Every existing test stayed green because in all of them the reference saw the torso, so the veto and the floor agreed. The defect only appears when they disagree — a reference that does *not* confidently see a shoulder — and it re-created the exact bug the ticket was fixing: demanding a body part of the user that the reference cannot see. Found by a review bot, not by three agent review rounds. So whenever a diff adds a floor, a default, an "always include" or a fall-back next to an existing filter: write the pin where the two rules point in opposite directions, and state the composed rule in one line (`(judged ∪ torso) ∩ confidently_seen`) — if the code and that line disagree, the code is wrong.

## Step 6 — Bound the blast radius

Trigger: an acceptance criterion phrased as "**X is unchanged**", or any change inside a shared numeric, scoring, or otherwise derived pipeline.

A fully green suite cannot answer "what else moved?" — it only proves that nothing *asserted* moved. Bound it mechanically:

1. `git stash` the changed files (or run the pre-change side in a second worktree),
2. run the repo's widest deterministic report from Step 0 over its whole corpus,
3. restore, run it again,
4. diff the two outputs.

Report the result as a number: which fields moved, which did not (e.g. "32 lines changed, every one a `signed` inside a rejection detail; no verdict, count, reason or channel moved"). That diff, not the suite, is the evidence for the criterion.

## Step 7 — Report what the suite cannot say

Close with:

- the seam table as executed — level, mode, and the deliberate negatives,
- pins listed as pins,
- the probe's numbers when one ran — what reproduced, and what the corpus actually reaches — as the baseline the red was judged against,
- any AC measure you substituted, with the numbers on both sides of the substitution,
- the unreachable ACs from Step 1 as explicit human-verification steps (hardware/human, and document/policy),
- the blast-radius diff summary, when Step 6 ran,
- which gates you ran and their result.

## Done when

A probe ran wherever Step 2 required one, and its numbers are in the report ✓ every seam in the table is red→green or pinned ✓ the red was re-verified honest by reverting the implementation ✓ every gate the repo runs in CI is green locally ✓ unreachable ACs named as human-verification items ✓ every deliberate deviation is a line in the ledger ✓

## What this skill does NOT do

- Choose the plan, the branch, or the seams (flow-start-ticket).
- Review style, architecture, or diff-vs-spec (flow-code-review), or issue a pre-merge verdict (flow-confidence-check).
- Commit, or open a PR (flow-create-commit, flow-create-pull-request).
- Discretionary refactoring — only restructuring a gate forces happens inside the loop.
