# flow-diagnose-bug

Find and prove the cause of a bug — and stop at the deliverable that was actually asked for.

The loop-first discipline is inherited wholesale from Matt Pocock's `diagnosing-bugs` and it holds:
a tight, deterministic, unattended command that goes red on *this* bug is worth more than any
amount of reading. What four battle-testing sessions changed is the gate around it. The upstream
skill lets nothing past Phase 1 until a loop asserts the user's exact symptom — written for the
case where you are about to write a patch. Three of those four sessions were not that case, waived
the gate, and improvised something ad hoc in its place.

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
- **A verdict** — "is this April crash still alive?" No loop; an evidence trail, answered with its
  confidence basis: test-proven, telemetry-proven, or merely claimed. See
  `references/verdict-mode.md`.
- **A decision** — the cause is a knob someone moved deliberately. Both measurements, the
  trade-off, a ticket; possibly no patch at all.

## What it handles that the upstream skill does not

- **Bugs that do not live in code.** A WASM bundle that never reached S3; a reference JSON retuned
  through an API and never committed. Neither has two commits to bisect, and for the first the
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

## Where it lives

A **personal skill** in `~/.claude/skills/flow-diagnose-bug/`, not in the shared `agent-skills` repo
— the team keeps the shared set small, and nothing is committed there while PR #8 is open. Nothing
to install; a new session picks it up.

It supersedes the upstream `diagnosing-bugs`, which is demoted to slash-only by the router
(`~/.claude/skills-router/routing.md`) rather than uninstalled, so `/diagnosing-bugs` still runs the
original. The siblings it hands off to — `flow-plan-ticket`, `flow-write-ticket` — are
personal or forked and know about this lane through the router, not through edits to the shared
repo.

## Usage

```
/flow-diagnose-bug
"diagnose why the camera errors on staging"
"why is the setup gate never passing since the retune?"
"is the April SIGABRT still a thing?"
```

## Provenance

Every rule is traceable to a session where its absence cost time. The provenance notes cite private session records, so they are kept outside this repository; read them before changing a rule.
