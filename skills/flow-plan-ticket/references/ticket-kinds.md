# Ticket kinds

Read the one your ticket is. The codebase-mapping step (SKILL.md Step 4) is shared by all four; what changes is what a *step* in the plan is, and what counts as evidence that it is done.

The exotic seams a code ticket can land on — an extraction, a build artifact, a CI job, a dependency's type contract, a persisted format, behaviour visible only across two layers — are catalogued in flow-tdd's `references/seam-modes.md`. Name the seam here; that file says how to test it.

---

## Code

The default kind, and the only one the plain red→green spine fits without translation.

The plan's steps are vertical slices, each with a test level from Step 0's vocabulary. Two things belong in the plan that a step list does not naturally carry:

- **The routing/integration seam.** A component green in isolation says nothing about whether navigating to it renders anything. When the ticket adds a route, a modal, a tab, or any entry point, that entry point is its own seam and its own step.
- **A step that changes *how* availability is decided** — swapping a hardcoded list for a value from an API, moving a check from client to server — is separate from the behaviour it enables. Those two arriving together is how a gate change becomes invisible at review.

When the ticket ships behind a flag, allow-list, pilot group, or plan tier, the plan carries an explicit step for the **off** state in every environment the change reaches. The on state gets exercised by accident; the off state does not.

---

## Data / ops

The deliverable is work a human performs — recording sessions, labelling, a manual migration, a corpus collected on staging. Code changes, if any, are tooling or documentation. The red→green spine is almost entirely inapplicable, and forcing it produces a plan nobody can execute.

The plan's core artefact is a **protocol** plus a **definition of done**, and it must answer:

- who performs it, on which environment, and how many times,
- what makes one unit valid (one recording, one labelled row, one migrated tenant),
- what makes the whole set complete — a count, a coverage matrix, a checklist,
- where the output lands, in what format, and against which contract,
- the convention for the awkward cases, decided *before* collection starts, not after,
- the boundary between data used for tuning and data used for validation, when both come from the same collection run.

A convention decided late invalidates everything gathered before it. Conventions are therefore Step 6 decisions with defaults, not open questions carried into execution.

---

## Pipeline / tooling

The ticket's deliverable is a CI job, a script, a repo setting, or a package manifest. **The job is the unit under test**, so evidence lives in the run, not the file.

- Red is a real run of the job failing — a deliberately failing throwaway test, or the job pointed at the broken state. Keep the run URL; it is the evidence, and it is what a reviewer can check.
- Green is the same job passing on a real run. A local green proves nothing about whether the job is wired.
- Delete the throwaway once red is recorded, and say so in the plan as its own step.

Watch for the escape hatches this kind of ticket usually exists to remove: `|| true`, `continue-on-error`, `--passWithNoTests`, a runner matching zero test files, a placeholder script that exits 0. A job that passes vacuously looks identical to a job that passes.

Half of a pipeline ticket is routinely not a code change at all — requiring a status check, adding a context, granting a token. That half goes through the hand-off walk (SKILL.md Step 5) before the plan promises it.

---

## Bug, already diagnosed

Reach this kind only when the diagnosis has actually run and produced a reproduction. If it has not, this is not the kind: route to flow-diagnose-bug first, then come back. Its locating loop is enough to plan on — it names the cause with numbers without asserting the user's exact symptom, and the regression test it hands over unwritten becomes step 1 of this plan.

Diagnosis has already built the feedback loop and the probe that reproduces the reported numbers. Do not rebuild it. **The probe becomes the first red**, which collapses the diagnosis phase and flow-tdd's first red into one step.

The plan therefore opens with "recreate the existing loop", states the reproduced baseline as numbers, and expects the ratio flow-tdd describes for bug fixes: exactly one test may legitimately be red — the regression test for the reported scenario. Everything a correct fix opens up (the new arithmetic, the null case, the fall-back) can only be a pin.

Fixture choice is a plan decision here, and it has one rule: **freeze a fixture when the test guards an algorithm; point at the live data when it guards the data.** A frozen copy can never catch the corpus changing underneath the fix.
