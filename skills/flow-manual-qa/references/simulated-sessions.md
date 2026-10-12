# Simulated sessions — when a harness stands in for the user

Read when a criterion is observed through a harness that simulates the user: injected sensor data, a
synthesised input stream, a scripted persona driving the real bundle. The app's own logic runs for
real; whatever the harness replaces does not, and every claim stays inside that boundary.

## A proxy is not a test

Classify every condition the criterion or the persona names into exactly one lane, and write the
table into the report:

- **modelled** — the injected input itself carries the effect (geometry, timing, behaviour the harness
  generates).
- **proxy** — a number was scaled, jittered or dropped to stand in for the condition. Write what moved
  ("lighting → visibility ×0.71, 4% dropout"). The row never says the condition was tested.
- **not modelled** — bypassed by the harness, declared but never applied, or a proxy whose effect is
  "no change". **What a harness declares is intent, not effect**: a condition moves to proxy only when
  the code that runs the session applies it.

Every proxy and not-modelled row becomes a `manual only` row — a person, a real room, a real file —
unless the same condition already has one.

**When a proxy alone can decide the outcome**, rerun with the proxy neutralised. A proxy constant that
pushes a value across the threshold a gate reads closes the gate by arithmetic. If the neutral rerun
changes the outcome, the proxy decided it, and every check it decided is `not verified`
(proxy-determined) — never a setup finding, never evidence about the condition.

**A stubbed backend is not the environment.** Name which parts were real (the deployed bundle, its
SHA) and which were stubbed (login, API, configuration read from a local file), and copy the harness's
own stub warning into the report header verbatim. A finding about stubbed data describes the local
file, not the deployed configuration; only the bundle's behaviour transfers.

## The recorded timeline is the only source of a verdict

What the simulated user did, saw and was told comes from the run's recorded artefacts — the event
timeline, the session record, the screenshots — and every such sentence cites the timestamp it came
from. Repository knowledge and predictions go under a separate *prior evidence* heading, never into
what happened. A run with no session record on disk has no report.

## Triage before `failed`

Compare the app with an oracle — the same logic run outside the app over the same input — and check
first that the comparison is fair: the oracle may be fed what the harness *counted* as performed, so
confirm the harness performed what the persona prescribed and that both were compared over the same
span.

| App vs oracle | Classify as |
|---|---|
| agree, and the persona was outside the documented setup guidance | setup finding, not an app defect — the guidance text can still be a defect if following it would not fix the cause |
| agree, and the persona's behaviour predicts the result | expected |
| a proxy decided the outcome | `not verified` (proxy-determined) |
| disagree | defect candidate — **rerun once with the same seed first**. A harness whose timing depends on CPU load or parallel sessions is not deterministic; a changed result is a harness problem, `not verified`, not a defect |
| run crashed, login failed, selector timed out | `not verified` (harness), never `failed` |

A defect already in `## verification register` or `## known issues` is cited as `known: <where>`, not
filed again.

## Red flags

- "Tested in dim light", "loose clothing worked" — the condition was never rendered; it was a proxy.
- A sentence about what the user did or was told with no timestamp citation.
- "Would likely", "expected to" anywhere but *prior evidence*.
- "On staging" for a run whose backend was stubbed.
- A gate closed by a proxy reported as a finding about the condition.
- A disagreement filed as a defect from a non-deterministic run with no rerun.
- A simulation driving the shared browser another session may be using — each run gets its own.
