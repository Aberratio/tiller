# What a test worth keeping looks like

A good test reads like a specification, observes behaviour through a public interface, and survives a refactor that changes nothing a caller can see. Code can change entirely; the test shouldn't.

## The three tautology forms

A test is worthless in a specific way: it cannot disagree with the code. Three routes get you there.

**1. Implementation-coupled** — mocks an internal collaborator, tests a private method, or verifies through a side channel (querying the database instead of reading back through the interface). The tell: refactoring breaks it while behaviour is unchanged.

```ts
// BAD — asserts HOW
expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
// GOOD — asserts WHAT
expect((await checkout(cart, card)).status).toBe("confirmed");
```

**2. Value-tautological** — the expected value is recomputed the way the code computes it, so it passes by construction.

```ts
// BAD
const expected = items.reduce((s, i) => s + i.price, 0);
expect(calculateTotal(items)).toBe(expected);
// GOOD — an independent literal
expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
```

**3. Selection-tautological** — the expected value is honest, but the *population the assertion runs over* came from your own measurement. You filtered until it passed (`frames within 0.10 of the phase boundary` because 0.15 fails), so the test's greenness encodes a number you fitted.

The cure is rarely a better-justified constant:

1. instrument **why** each excluded item fails — often the exclusions split into "legitimately varies" and "never legitimately fails";
2. narrow the asserted condition to the one that *cannot* legitimately vary over the loosened population, so the population can come from the domain model instead of from the measurement;
3. add the complementary claim that needs no population at all — "the boundary-most item the pipeline can score at each end clears the whole gate";
4. if a constant survives all that, it comes from the domain model (an exported `REST_PHASE_BAND`), never from the run that produced the expected result — and the test comment states the numbers on both sides of it.

## Where expected values come from

In rough order of preference:

- a **hand-worked example** computed from the spec or an ADR before any code was touched (17 frames at −27° → norm 1.8, 3 at +120° → norm 8, median 1.8, excess 0.9, whole-rep mean −4.95 — and the first red printed exactly −4.95, which is what proved the test reproduced *the reported bug*);
- the **format's or field's documented meaning** (`belly_curvature` IS the leading coefficient of the recorded contour, so `0.42` pins the contract, not the code path);
- the **other side's contract**, copied into the test with a comment (a client-side filename asserted against the server's `/\A[A-Za-z0-9_.-]+\.json\z/`, which is what makes the test able to catch a future slug format the server would 400 on);
- **recorded output of the pre-change code**, for extraction/parity work only (see `seam-modes.md`).

**And one source that looks independent and is not: a hand copy of a table the repo already exports.**
Where the rule under test is defined by a lookup table in the codebase, re-deriving the expectation
from your own restatement of that table is not independence — it is a second chance to make the same
mistake, and it fails silently outside whatever range the fixtures happen to exercise. Measured on
ABC-226 (2026-08-22): a test asserting that a mirrored reference demands the *paired* landmark of
each one it demanded before computed the pairing as "odd is left, from index 11 up". The repo's own
`SIDE_LANDMARK_PAIRS` also pairs the face and ears — `[1,4] [2,5] [3,6] [7,8] [9,10]` — which are
not adjacent odd/even, so the helper was wrong for ten of the thirty-three indices. It passed anyway,
because no reference in today's corpus demands any of them; found by the profile's review-bot gate, not by the mutation
pass, since every mutation ran through the same wrong helper. Import the exported accessor
(`mirrorLandmarkIndex`) instead. The tell is worth learning: an expected value derived from *your*
copy of a domain table is as coupled as one recomputed the way the code computes it, but it reads
like a hand-worked example, so review does not challenge it.

Two assertions that disagree with each other are worth more than one: assert the whole-rep mean is still negative *alongside* the surfaced direction being positive, and the test pins the divergence itself rather than passing whenever both aggregations happen to agree.

## Mocking

Mock at **system boundaries**: external APIs, third-party services, the network, time and randomness the code legitimately owns, sometimes the filesystem. Prefer SDK-shaped boundary interfaces (`api.getUser(id)`) over one generic `fetch(endpoint, opts)`, so each stub returns one shape and needs no conditional logic.

Where the repo's own convention says to stub every collaborator (common for component tests), one rule outranks it:

> **A collaborator that computes the value under assertion is never mocked, however internal the convention calls it.**

Stubbing it converts the test into a restatement of the fixture — you assert that the picker shows the rows you handed it, and the ranking bug the ticket describes is invisible. The decision test: *replace this collaborator with a stub — can the test still fail for the reason the ticket describes?* If no, keep it real, and write the reason into the test file so the deviation from the repo's documented rule is visible to a reviewer. Pure, deterministic, in-repo maths is the normal case for keeping it real; the cost is usually a second per render, which is acceptable.

## Fixtures

- **Pin the condition, not an instance that happens to satisfy it.** A real reference that reproduces the bug today may reproduce it for an incidental reason (two mask channels occupying the top slots). Put branch coverage on a synthetic input that pins the *shape* the bug needs, and let the real-data test assert only the durable claim.
- **Check in-flight work on the same data.** A sibling ticket that changes the ranking, the corpus, or the schema can dissolve your fixture's condition and turn the regression test green for an unrelated reason. Ask what is in flight against this data before choosing the fixture.
- **Freeze the fixture when you are guarding an algorithm; point at the live data when you are guarding the data.** A trimmed `__fixtures__` copy is right for parity tests; a test whose guarded failure mode is "the corpus changes" must import the live corpus, and say so in a header comment.
- **Real-data fixtures are legitimate** when believable inputs cannot be hand-authored (33-landmark human motion, a recorded session). Trim the recording to just past the last relevant event, import it statically, and treat that as module loading rather than the disk I/O a unit-test rule bans.
- **Derive a new-format fixture by transforming a real one** (`{...frame, mk: {…}}`) rather than hand-authoring a document — the surrounding data stays real, so the pipeline is still exercised end to end.
- **Prove the fixture reaches the branch the test's name promises — by mutation, not by reading.** A test called "falls back to the full seen set when nothing is judged" was asserting the *other* branch: its `seen` list contained landmark 24, which the judged channel also reads, so the narrowing branch was non-empty and ran instead. It passed, its expected value happened to be identical, and it sat there through two review rounds until an external review bot read the fixture. The check costs seconds: **flip the branch condition to a constant (`if (narrowed.size)` → `if (true)`) and watch the test go red.** If it stays green, the fixture never reached that arm, whatever the name says. Do this for every branch-coverage test whose input is a hand-built list of indices, ids or flags — that is where the accidental overlap hides. When a fixture turns out to cover a *different* arm than promised, keep it under a name that matches what it really covers, and add the intended one.

## Pins

A **pin** is a test that is green on arrival by design: it exists so that deleting or weakening preserved behaviour fails the suite. Name it as a pin. Pins are legitimate, expected, and — for a bug fix — the majority of the tests worth having. What they are not is a substitute for the one red that proves the reported scenario is fixed.
