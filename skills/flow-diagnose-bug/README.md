# flow-diagnose-bug

Find and prove the cause of a bug — and stop at the deliverable that was actually asked for.

Adapted from the public `diagnosing-bugs` skill in <https://github.com/mattpocock/skills>. The
loop-first discipline holds: a tight, deterministic, unattended command that goes red on *this* bug
is worth more than any amount of reading. What changed is the gate around it. The upstream skill
lets nothing past Phase 1 until a loop asserts the user's exact symptom — written for the case where
you are about to write a patch. Most diagnoses are not that case, so the gate was waived in
practice and something ad hoc took its place.

## Where it sits

| | **flow-diagnose-bug** | flow-plan-ticket | flow-tdd |
|---|---|---|---|
| When | something is broken, slow, or of unknown status | the cause is known, the work isn't planned | the plan exists |
| Owns | the loop, the cause, the confidence basis | premise, kind, seams, hand-offs | red→green, pins, blast radius |
| Output | a proven cause (or a verdict, or a trade-off) | the plan | the change |

The probe this skill builds is not thrown away at the border: `flow-plan-ticket`'s
`bug-after-diagnosis` kind expects it, and it becomes `flow-tdd`'s first red.

## The four deliverables

Naming the deliverable first is the whole point, because it sets how strong the loop has to be.

- **A fix** — full run, regression loop asserting the user's symptom.
- **A plan** — a *locating* loop is enough: it may assert one layer below the symptom (ranking
  numbers rather than a missing checkbox) as long as it names the cause with numbers. Exit before
  implementing; the regression test is named and handed on unwritten.
- **A verdict** — "is the crash from last spring still alive?" No loop; an evidence trail, answered with its
  confidence basis: test-proven, telemetry-proven, or merely claimed. See
  `references/verdict-mode.md`.
- **A decision** — the cause is a knob someone moved deliberately. Both measurements, the
  trade-off, a ticket; possibly no patch at all.

## What it handles that the upstream skill does not

- **Bugs that do not live in code.** A build artifact that never reached its bucket; a config value changed
  through an admin API and never committed. Neither has two commits to bisect, and for the first the
  regression test is a CI assertion on the build artifact — the e2e suite ran green against a
  replay stub the whole time staging was broken.
- **Orientation reads are legal.** For a deployment bug you cannot name the command to run before
  reading which URL serves the asset and which workflow deploys it. Only theory-building without a
  loop stays forbidden.
- **The SPA 200-but-HTML fallback** as a named failure class — every URL returns 200 and every
  asset is broken.
- **Concurrent in-flight work.** A sibling ticket can silently fix your reported case while leaving
  the bug intact, turning a regression test written against today's data into a tautology. There is
  a checkpoint for it between reproduction and fix.
- **The differential loop is its own hypothesis test** — one recording, one field flipped, two
  runs. Splitting that into a separate ranked-hypothesis phase doubles the work.

## Changed from the upstream `diagnosing-bugs`

- **"No red-capable command, no Phase 2" as an absolute gate** → kept as the default, but tiered by
  deliverable (Step 0) and paired with explicit permission for orientation reads (Step 1). An
  absolute version gets waived in practice; a rule waived that often is mis-stated, not disobeyed.
- **Every loop must assert the user's exact symptom** → split into locating vs regression loop.
- **Hypotheses as an always-separate phase** → collapses into the loop when the loop is
  differential.
- **Phase 5 assumes a code seam** → adds the CI-artifact seam, and the case where the right
  deliverable is a decision rather than a test-and-patch.
- **Post-mortem hands off to `/improve-codebase-architecture`** → `codebase-design`, which owns
  that lane here.
- **Added outright:** verdict mode, the in-flight-work checkpoint, and the confidence basis.
- **Timing-flake recipe:** imitating the slow environment reached a 6% reproduction rate; amplifying
  the mechanism reached 90%.

## Where it lives

`skills/flow-diagnose-bug/` in this repository; `install.sh` links it like every other skill. It
supersedes the upstream `diagnosing-bugs` for this harness. The siblings it hands off to —
`flow-plan-ticket`, `flow-write-ticket` — know about this lane through their own descriptions.

## Usage

```
/flow-diagnose-bug
"diagnose why the checkout form errors on staging"
"why is the nightly export never finishing since the config change?"
"is that crash from April still a thing?"
```

## Provenance

Every rule is traceable to a debugging session where its absence cost time.
