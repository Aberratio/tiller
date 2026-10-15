---
name: flow-diagnose-bug
description: Find and prove the cause of a bug, a performance regression, or a "did this ever get fixed?" question - loop-first, with the loop's required strength set by what you owe at the end (a patch, a plan, a verdict, or a trade-off decision). Use when the user says "diagnose this", "debug this", "why is this failing/slow", reports something broken on staging or in production, asks whether an old reported bug is still alive, or asks what is behind a ticket before it can be planned. Covers bugs that live outside code too.
---

# Diagnose a bug

## Step −1 — Resolve the project profile

Read `$TILLER_HOME/skills/_shared/resolve-profile.md` and follow it; no profile resolves → stop.

The loop is still the skill: a command you can run unattended that tells you, in seconds and
without argument, whether the bug is present. Everything else — bisection, hypotheses,
instrumentation — just consumes it. Reading code to build a theory before you have one is the
failure this skill exists to prevent.

**The loop you owe depends on what you owe at the end.** A gate of "a loop asserting the user's
exact symptom before you may think" is written for a patch; when the deliverable is a verdict, a
plan or a decision it gets waived, and a waived gate is unreviewable. This skill states the tiers
itself (Step 0).

## Step 0 — Name the deliverable, out loud, first

| You owe | Loop you must build | Where it ends |
|---|---|---|
| **A fix** | Regression loop (asserts the user's exact symptom) | Steps 1–8, fix + regression test |
| **A plan** | Locating loop (may assert one layer below the symptom) | Step 7 → hand to `flow-plan-ticket`, carrying the unwritten regression test as step 1 of the plan |
| **A verdict** ("is this still a bug?", "did it disappear?", "it works now — did we change something?") | Usually none — the evidence trail is the instrument; for "it works now", a cross-product of artifacts × configs | `references/verdict-mode.md`; reproduction only if the verdict is "still alive" |
| **A decision** (a knob was moved on purpose) | Differential loop, one field flipped | Step 7 → trade-off stated, ticket via `flow-write-ticket`; there may be no patch at all |

Say which one you are on before Step 1. If the user has not said, ask — it is one question and it
changes every step that follows. Changing lane mid-diagnosis is fine and common (a verdict comes
back "still alive"); say that out loud too.

## Step 1 — Orientation reads (allowed, bounded)

Read to find out *where the bug lives*: the error string, the code path that emits it, the deploy
path that ships it, the config that feeds it. Read `CONTEXT.md` and the ADRs for the area — a
domain rule ("an order has exactly one owner") is what makes an acceptance criterion meaningful
rather than decorative.

For an environment or deployment bug this step is not optional: you cannot *name* the command to
run until you know which URL serves the asset and which workflow deploys it. The bug need not
live in code at all — a missing deploy artifact, a retuned config value, or data that changed
without a commit are all in scope; the loop then asserts against the artifact, the config or the
data instead of a function.

What stays forbidden is the other kind of reading: **building and testing a theory without a
loop**. Orientation ends the moment you catch yourself explaining the bug to yourself.

## Step 2 — Build the loop, at the tier Step 0 requires

A **locating loop** may assert one layer below the user's symptom — a ranking instead of a
missing list item, a per-stage pass count instead of a stuck button — as long as it produces
**numbers that name the cause**. Cheap, fast, and enough to hand someone a plan.

A **regression loop** asserts the user's exact symptom, and is allowed to be *the first commit of
the fix* rather than a prerequisite of the diagnosis. Requiring it before you are allowed to think
is what makes people skip the loop entirely.

Both tiers must be: **deterministic** (same verdict every run; for flaky bugs, a pinned high
reproduction rate), **fast** (seconds), and **agent-runnable** (unattended; a human only via a
structured HITL script). Paste the invocation and its output the first time it runs.

For a **timing flake**, drive the variable the slow machine actually changes rather than loading the
machine. Recipe and the control that keeps an amplifier honest: `references/loop-recipes.md`, which
also carries the deployed-environment/artifact and config-tuning differential recipes.

Then tighten it: faster, sharper signal, more deterministic. A 30-second flaky loop is barely
better than none; a 2-second deterministic one is a different job.

**If you genuinely cannot build one:** say so explicitly, list what you tried, and ask for
environment access, a captured artifact, or permission to instrument. Do not slide into
hypothesising. If the question was "is this still a bug?", you are not stuck — you are in verdict
mode, which is a different track, not a degraded one.

## Step 3 — Reproduce, then minimise

Watch it go red. Confirm it is the **user's** failure mode and not a neighbour — wrong bug, wrong
fix. Capture the exact symptom so a later step can prove the fix addressed it.

Then cut inputs, callers, config, data and steps one at a time, re-running after each cut. Done
when every remaining element is load-bearing. The minimal repro is what shrinks the hypothesis
space, and it is the regression test's skeleton.

## Step 4 — Check what else is in flight

Before you trust the repro as ground truth, list the open or in-progress tickets, branches and
migrations touching the same code path or the same data. For each, state whether it would change
what the repro measures.

Example: a sibling ticket that removes some inputs from a ranking would lift the missing item into
the visible top three on its own — the reported case passes by accident, the truncation bug stays
alive for every other input, and a regression test written against today's ranking becomes a
tautology.

If something in flight would move the ground truth, the regression test must pin **the condition
itself** in a fixture (here: the expected item ranked below the cutoff), not today's real-world data.

## Step 5 — Hypotheses: 3–5, ranked, falsifiable

Each states its prediction: "if X is the cause, changing Y makes it disappear". No prediction, no
hypothesis. Show the ranked list to the user before testing — domain knowledge re-ranks it
instantly ("we deployed a change to #3 on Tuesday") — but don't block on an AFK user.

**When the loop is differential, this step is already done.** Replaying one input through two
values of one config field *is* the hypothesis and its test; writing the list out separately
doubles the work and teaches you nothing. Say that you are collapsing the step, and why.

## Step 6 — Instrument only what a prediction asks for

Debugger or REPL first — one breakpoint beats ten logs. Then targeted logs at the boundaries that
*distinguish* hypotheses. Never log-everything-and-grep. Tag every debug log with a unique prefix
(`[DEBUG-a4f2]`) so cleanup is one grep; untagged logs survive forever.

Change one variable at a time.

**Performance work is measurement, not logging:** establish a baseline (timing harness, profiler,
query plan), then bisect. Measure first, fix second — and measure before theorising generally,
because the numbers routinely contradict the sentence you were about to write.

## Step 7 — Land it, according to Step 0

**Fix.** Regression test before the fix, at a seam that exercises the real bug pattern as it
occurs at the call site. A too-shallow seam gives false confidence — and if no correct seam exists
in code, *that is the finding*, not a reason to skip it. The seam is not always a code test: for a
missing or malformed deploy artifact it is **a CI assertion on the build output** ("`dist/` must
contain the generated assets after Build"), because no unit or e2e test can catch a file that was
never shipped — an e2e suite running against a stub stays green while staging is broken. Then: red →
fix → green → re-run the original, un-minimised loop. The red-green loop itself belongs to
`flow-tdd`; hand over the probe, it becomes the first red.

**Plan.** Stop here. Hand `flow-plan-ticket` the cause with its numbers, the fix shape you chose and
why, and the regression test you did *not* write, named at its seam. Do not implement and do not
clean up as if you had.

**Verdict.** State the confidence basis in the answer itself: test-proven (a loop went red then
green), telemetry-proven (zero recurrences since the release, with the window named), or merely
claimed (a ticket says fixed and nothing corroborates it). Those are three different answers and
collapsing them is how a closed bug comes back.

**Decision.** When the cause is a knob somebody moved deliberately, the deliverable is the
trade-off, not a patch: both measurements, who owns the call, and a ticket. Record it in the
branch's ledger (`flow-decision-ledger`) if it departs from a documented convention.

## Step 8 — Close out

- [ ] Original repro no longer reproduces — re-run the Step 2 loop, un-minimised
- [ ] Regression test passes, or the absence of a correct seam is written down
- [ ] Every `[DEBUG-…]` line gone (grep the prefix), throwaway probes deleted
- [ ] The hypothesis that turned out **correct** is in the commit or PR message
- [ ] The confidence basis is stated — see Verdict above; it applies to a fix too

Then ask what would have prevented this bug. If the answer is architectural — no seam, tangled
callers, hidden coupling — hand the specifics to `codebase-design`. Ask it *after* the fix is in;
you know more now than when you started.

## What this skill does NOT do

- **Write the regression test or the fix** — that is `flow-tdd`, which inherits the probe as its
  first red.
- **Plan the work** — `flow-plan-ticket`, which takes the diagnosis as input (its
  `bug-after-diagnosis` kind exists for exactly this hand-off).
- **File or rewrite the ticket** — `flow-write-ticket`.
- **Judge whether the finished branch is shippable** — `flow-code-review`, then
  `flow-confidence-check`.
