---
name: flow-run-day
description: Launcher for an unattended day of ticket runs - build the day's args from an approved queue, render the supervisor environment from the profile, and hand the waves to the Node day driver. Use when the user asks to run the day's plan unattended, to run a queue of tickets in waves, or to resume an interrupted day.
user-invocable: true
---

# Run a day unattended

This document is what happens **before** the day and **after** it comes back. Waves, the ceiling,
the owner-proxy calls and the sweep live in the day driver, `lib/driver/day.mjs`, where each ticket
runs the Node ticket driver in its own process. The children share `STATE_ROOT`.

## Step 0 — Preconditions

1. **The queue is approved before launch.** The owner approves the waves (which tickets, in which
   order, which run in parallel). The runner never adds a ticket of its own.
2. **The profile allows an unattended day.** It needs a `## owner proxy` section, a day ceiling and
   a parallelism cap. Without them `day-args` refuses, and the refusal is the answer.
3. The capability probes of `flow-run-ticket` Step 0 apply unchanged.

## Step 1 — Build the args

The queue is a JSON array of waves; each entry is a key, `{ "ticket": KEY, "summary": "<ticket summary>", "notes": [...] }`
(`summary` names the branch, as `--summary` does for one ticket), or,
on a profile with no tracker, `{ "spec": "<path>" }`.

```bash
node "$TILLER_HOME/skills/flow-run-ticket/bin/harness.mjs" day-args \
  --profile "$PROFILE" --date "$(date -u +%F)" --queue waves.json [--root <STATE_ROOT>]
```

It validates every entry the way the ticket builder does, refuses a ticket queued twice, and writes
`<root>/args-day.json`.

## Step 2 — Launch

Bash with `run_in_background`:

```bash
node "$TILLER_HOME/skills/flow-run-ticket/bin/harness.mjs" drive-day --args <root>/args-day.json
```

It prints one line `{status, dayStatus, reason, results, record, journal}`. Exit 0 is any terminal
day status, `ceiling`, `parked` and `paused-usage` included; 1 is a crash, 4 a refusal, 128 + n a
signal. `<root>/day-result.json` is the completion record: `running` with the driver's pid while the
day runs, the outcome on every exit it can catch (a crash and SIGTERM/SIGINT/SIGHUP included). A
record still `running` whose pid is gone means the driver was killed outright (SIGKILL, power loss).
A second driver on the same root is refused while the first holds the day lock. Relaunching after a
crash is the same command: finished tickets are skipped, started ones resume from their checkpoints.
Every lane call is journaled in `<root>/tickets/day-<date>/driver-journal.jsonl` and each ticket's in
its own journal; `lib/driver/journal.mjs --report <journal>` gives the numbers.

For a day that must outlive one session, run it under the supervisor with its environment rendered
from the profile:

```bash
node "$TILLER_HOME/skills/flow-run-ticket/bin/harness.mjs" supervise-env --profile "$PROFILE" [--disallow <tool>]...
```

Export `env.SUPERVISE_STOP_HOUR` and `env.SUPERVISE_DISALLOWED_TOOLS` from its output, then run
`lib/supervisor/supervise.sh <brief>`. The disallowed tools are the hard-stop channels the profile
names: every write op in `config/tool-kinds.json` that reaches one; an unattended child never holds them.

## What the day does on its own

- Before every chunk of parallel children it counts open decisions under `STATE_ROOT`, including
  those written by other sessions. At the ceiling nothing new starts; the owner proxy is asked once
  to lift it, and without that mandate the day stops with status `ceiling`.
- Harness blocks and ready-to-sign parks are never counted and never asked to anyone.
- A wave after the first starts only through the owner proxy.
- A usage limit pauses the day (`supervisor: paused-usage <reset>` in `state.md`); the relaunch
  skips finished children and resumes started ones from their checkpoints.
- When the base branch moved since the last sweep (by the day's merges or any other), one sweep lane
  looks for regressions across the changes; each becomes a decision.

## When it comes back

The driver journals its own calls; nothing is appended by hand. Read the outcome from
`day-result.json`. Then report, in this order: the ready-to-sign list, open decisions as questions with
options, the regressions from the sweep. Quote gates from the forge, never from the result.
