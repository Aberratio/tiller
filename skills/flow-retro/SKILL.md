---
name: flow-retro
description: Use after an unattended day or a batch of ticket runs has come back, when the runs under a profile's run-state directory have not been read as a whole - parks that recur, decisions left open, spend concentrated in one lane, verdicts overturned - or when someone asks what the harness should change before the next run. Writes a dated note that proposes edits; it changes nothing.
user-invocable: true
---

# flow-retro

The retro reads every run under the profile's run-state directory and writes one dated note:
what the runs did, where they stopped, what it cost, which verdicts did not hold, and the edits
that evidence supports. The note is a proposal. The retro edits no skill, no profile, no cap, and
writes no measured scores; `harness.mjs calibrate` does that, on the owner's say.

**Rule zero: a proposal without an evidence line is an opinion, and the note carries none.** Every
proposal names one target and the run facts it rests on; the script refuses any other shape.

## Step −1 — Resolve the project profile

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .        # prints the profile file; non-zero means stop
```

No profile → stop. A retro over another project's runs proposes edits to the wrong profile.

## Step 1 — Write the note

```bash
node "$TILLER_HOME/skills/flow-retro/bin/retro.mjs" --profile "$PROFILE" [--root <run-state dir>] [--date YYYY-MM-DD] [--min-n N] [--dry-run]
```

The root defaults to `TILLER_RUN_STATE`, else `~/.claude/run-state/<profile name>`; pass `--root`
when a day ran on an explicit `STATE_ROOT`. The note lands at `retros/<date>.md` beside the profile,
outside version control like the doubt log. The result line names the runs, the tickets, the runs
that stopped and the count of proposals; `--dry-run` prints the note instead.

The note has these sections, in order: Runs, Park causes, Open decisions, Spend, Calibration,
Proposals, Not proposed. Read all of them before quoting one.

## Step 2 — What a proposal is

Each proposal is one line `- \`<target>\`: <edit>` with `evidence:` lines under it, where the target
is one of:

| Target | Proposed when |
|---|---|
| a profile section (`## run policy`, `## gates`, `## ticket conventions`, `## escalation`, `## model routing`) | the same park cause or open decision kind recurs, a lane's verdicts are overturned at 0.15 or more over at least `--min-n` (10) of them, or one lane takes 40% or more of the spend |
| a cap (`caps.<name>` in `## run policy`) | the park cause is the cap running out |
| a lane schema (`lib/contract/schemas/lane-<lane>.json`) or its brief | a lane's output fails its schema twice or more |
| `skills/flow-run-ticket/SKILL.md` | a cause the mapping does not know recurs |

A merge-authority row, an inviolable and the owner-proxy mandate are never targets, however often
a run parked on them: a park there is the harness working, and a change there is the owner's
decision. The script throws rather than propose one.

## Step 3 — Hand it over

Report the note's path and its proposals as choices: for each, what it gains, what it loses and
what reversing it costs. Nothing is applied here. An accepted profile edit goes through the profile;
an accepted cap through `## run policy`; an accepted routing change through `## model routing` or
`harness.mjs calibrate`, which writes `config/measured.json` from the same ledgers.

## Hard stops

- No profile resolves → stop; do not point the script at a guessed directory.
- No runs under the root → the note says so; do not read another profile's runs to fill it.
- A proposal the owner declined last time is not re-proposed by hand; the next run's evidence
  either changes the numbers or it does not.

## Tests

```bash
node --test 'skills/flow-retro/tests/*.test.mjs'
```
