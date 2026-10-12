# Seams that are not a plain function call

Each mode below answers three questions: **what is the seam**, **what is the honest red**, and **where does the test permanently live**. Pick the mode in Step 3; if two apply, run both.

## Extraction / characterization — "behaves identically to the code it came from"

The correctness criterion is parity, so the usual rules bend in three defined places.

- **Seam**: the new module's public entry point (the extracted pipeline, engine, or mapper).
- **Honest red**: a characterization pin first — replay real recorded input through the new module and assert it reproduces the counts/events the pre-change code recorded at capture time. Those recorded outputs *are* an independent source of truth: they were produced by the old code path, not by yours. Behavioural deltas that the ticket intends come after, as ordinary red→green.
- **First slice is allowed to be big.** Pinning a whole pipeline in cycle one is correct here; the one-seam-one-minimal-implementation rule is about design feedback, and there is none to get from a parity harness.
- **Probe first** (Step 2): replay *every* stored recording through the intended shape and check parity against each one's recorded result. That both validates the approach in minutes and selects the fixture — mismatches usually have explanations (a reference retuned after capture) worth knowing before you write a test.
- **Home**: the repo's normal test suite, with the trimmed recording under `__fixtures__`.

## A build or deploy artifact — the seam is the thing produced

When the bug lives in build/deploy plumbing, no code-level test can catch the regression (`npm run build` shipping without the wasm assets; the e2e suite substitutes a double and never loads them).

- **Seam**: the produced artifact — "`npm run build` must produce `dist/<assets>/**`".
- **Honest red**: run the assertion from a state that **reproduces CI's clean state** — locally generated inputs wiped first (`rm -rf public/<generated>`), because local dev state masks the bug. Watch it fail, then add the minimal prebuild step.
- **Home**: a guard script wired as a permanent `postbuild` hook, so the protection travels with the build command instead of living only in a workflow file.

## A CI job — the job is the unit under test

Pipeline/tooling tickets ("`npm test` is a stub", "a failing test must block the merge") have no feature to drive.

- **Seam**: the CI job's outcome.
- **Honest red**: watch the job fail **on a real run** and keep the run URL as evidence. Insisting on the red is what proves the runner is genuinely wired rather than silently matching zero test files — the exact failure mode the ticket exists to fix. A deliberately failing throwaway test is the right instrument; remove it in the green step.
- **Watch for the half that is not a code change at all** (a required status check needs repo-admin rights). Check the permission up front (`gh api repos/<org>/<repo> --jq .permissions`) and hand that half off explicitly rather than closing the ticket half-done.

## A dependency's contract — the red lives in the typechecker

Adopting another package's breaking change often leaves host runtime behaviour untouched.

- **Seam**: the **imported type**. Build fixtures from the package's real exported types, never hand-rolled shapes, so future contract drift fails typecheck in the host.
- **Honest red**: write the fixture in the *outgoing* shape and watch `tsc --noEmit` fail (`Type 'number' is not assignable to type 'PerformedSet[]'`), then switch to the new shape for green. Produce that red once and revert it.
- **Expect the runtime tests to be pins** and label them (pass-through unchanged, single-item case unchanged). The compile gate is the regression protection the ticket actually needs.

## A persisted format — the new field exists in no data yet

A field added to a recorded format appears only in data captured *after* the change ships, so on day one every fixture lacks it.

- **Seam**: the consumer of the format (the replay/reader), plus the writer.
- **Honest red**: transform a real recorded document in-test to carry the new field; take the expected value from the field's documented meaning.
- **Cover every state of an optional persisted field** — absent (the format predates it), present-and-null (the session genuinely had none), present-with-value. The absent/null distinction is usually load-bearing and is exactly what a naive `?? null` erases. When the field is also a **key** somewhere else, add present-and-blank: a whitespace-only id passes a truthiness check and then fails to resolve.

## Behaviour visible only across two layers

Some claims are not observable at any single seam — "a published reference must pass its own start gate" needs the framework-agnostic lib *and* the consuming package.

- **The test lives in the layer that may legally depend on both.** Never invert a dependency direction to reach a seam (a lib must not import its consumer).
- Keep branch coverage for each participant at its own seam; the composed test asserts only the claim that needs both.

## A UI component

- **Extract first.** Logic sitting in a render body or an `onClick` callback is at no seam at all: extract it as a pure function with one call site, unit-test the branches in milliseconds, and keep one readable DOM test for the wiring. The alternative — a heavy DOM-only file — is slower, flakier, and tests less.
- **Mock the network boundary, keep the computation real** (see `test-quality.md`).
- **Clear the harness before trusting the first red** — `harness-traps.md`.
- **Routing integration is its own seam.** A component test renders the component directly and mocks routing, so it cannot see that the route is nested under a parent that renders no `<Outlet/>` and therefore mounts nothing. If the ticket adds a route, one test must navigate to the real URL.
