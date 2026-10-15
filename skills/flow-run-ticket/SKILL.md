---
name: flow-run-ticket
description: Launcher for an unattended end-to-end run of one ticket - resolve the project profile, render its facts, run the pre-flight probes, and hand the run to the Node driver. Use when the user asks to run a whole ticket unattended, to run a ticket end-to-end, or to resume an interrupted run.
user-invocable: true
---

# Run one ticket unattended

This document is what happens **before** the run and **after** it comes back. The phases and the
gate live in the driver (`lib/driver/`); nothing here re-decides them.

The driver reads no profile. Every project fact it branches on arrives in the args, rendered once
here, in bash, before anything spawns. Contract: `docs/profile-schema.md`, "The facts object".

## Step −1 — Resolve the profile and render its facts

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .        # prints the profile file; non-zero means stop
"$TILLER_HOME/lib/profile-facts.sh" --check .  # per-key report; exit 4 means this launch is refused
FACTS="$("$TILLER_HOME/lib/profile-facts.sh" .)"
```

Run all three, in that order, at every start **and at every resume**. The profile is read fresh each
time, never replayed from a run record: an incomplete profile is unblocked by editing the profile,
so the snapshot is per attempt. A finished step replays from the journal only on the same input,
so exactly those lane calls whose briefs carried a changed fact re-run and the rest stay replayed.

**`--check` exits 4 → stop and report which sections it named.** Do not start and hope the run gets
far enough to matter. Do not fill the gap from another project, from the repository, or from what
this session already knows. A missing fact is not a permission.

Sections the contract does not cover yet are printed as `pending`. They do not refuse a launch; the
phase that needs one stops there instead.

## Step 0 — Capability probes, before anything else

Every probe is a hard stop, not a warning.

1. **`Bash` and a `claude` on `PATH`.** Missing → stop immediately, without touching the tracker:
   Step 3 is the only entry this launcher has. If you are reading this as a subagent, hand the
   launch back rather than starting a pre-flight you cannot finish.
2. **Write probe** — two words into the session scratchpad. Refused → stop.
3. **Tracker auth**, only when `facts.jiraKeys` is non-empty — the tracker tools plus a whoami call.
   Missing → stop; the run opens with a ticket read and a status move, so a run that cannot reach
   the tracker fails in its first phase after spending a worktree.

## Step 1 — The ticket, or a spec

Take the key from the user. Its project key must be one of `facts.jiraKeys`; a key from another
project means the wrong profile resolved, which is a stop, not a correction.

A repository whose profile sets the tracker to `none` takes `--spec <path>` instead: a Markdown file
that stands in for the ticket. The spec's file name becomes the run's key. A spec on a tracked
profile, or a key on an untracked one, is refused by the args builder.

## Step 2 — Build the args

```bash
node "$TILLER_HOME/skills/flow-run-ticket/bin/harness.mjs" args \
  --profile "$PROFILE" --date "$(date -u +%F)" --ticket KEY-1234 --summary "<ticket summary>" \
  [--root <STATE_ROOT>] [--note "<ruling>"]... [--hold-merge "<reason>"]
```

It renders the facts, initialises the run state under `STATE_ROOT` and writes
`<root>/args-<ticket>.json`. A non-zero exit is a refusal with its reason; do not work around it.

**`--note` is the channel for rulings at (re)start, not a workaround.** Each line reaches the phase
briefs, and it is the only way an answer reaches a phase that has already asked its question. When
restarting after a park, pass the ruling lines again rather than expecting a phase to find them.

`--summary` names the branch `<KEY>-<first words of the summary>`, the repo convention; pass the
ticket summary as the tracker shows it. A name the primary checkout already has as a local or
remote-tracking branch gets a four-hex suffix. Without it the branch is `<KEY>-run-<hex>`.
`--branch <name>` sets it outright, and only a given branch is exempt from the duplicate guard.

`--hold-merge` stops at an open pull request even on a green gate.

## Step 3 — Launch

Bash with `run_in_background`:

```bash
node "$TILLER_HOME/skills/flow-run-ticket/bin/harness.mjs" drive --args <root>/args-<ticket>.json
```

It prints one line `{status, runStatus, reason, prUrl, journal, steps}` and writes the result
object to `<root>/tickets/<ticket>/driver-result.json`. Exit 0 is any terminal run status, parked
and paused-usage included; exit 1 is a crash. The per-call numbers:
`node "$TILLER_HOME/lib/driver/journal.mjs" --report <journal>`.

**Resume is automatic.** The run state lives under `STATE_ROOT`; a relaunch with the same args
reads the checkpoints and skips every phase that already finished, so a run that died mid-phase
restarts that phase, not the ticket. Relaunching after a crash is the same command.

The run works in the background. Wait for it; do not predict its results. The driver journals
every lane call with its outcome, so `lib/journal/spend.mjs` joins each lane's spend to its result
without any help from here.

A merge the agent may not make parks with the pull request open and lands on the ready-to-sign
list (`readyToSign` in the result); it is not a failure and not a question.

A run that ends parked is recorded in the helm (silent when there is none): `"$TILLER_HOME/lib/helm/record.sh" --kind parked --summary "<ticket>: <condition for return>" --link <PR url when one exists> --source flow-run-ticket`.

## Step 4 — When it comes back

**Read every gate from its source before quoting it.** Gate fields written into the state file are a
phase's *claim*, not a measurement, and they have been false — a phase has reported a clean gate on
a pull request that was a draft, had changes requested, and had a failing job. Re-read the pull
request, the checks and the review list from the forge itself.

A review bot reporting `SUCCESS` as a check is not evidence of a review. Read the reviews by commit
id. A job result after a re-run is overwritten, so a listing shows the latest attempt, not the one
the gate was decided on.

### When the run did not come back

1. Read the run's state file — the last phase it recorded is where it died.
2. Relaunch with the same args (Step 3); the checkpoints decide what is redone.
3. Ask the user exactly one thing — whether this was a stop or a death. Everything else about the
   state is readable, that is not.

### After a day of runs

When the runs of a day are back, read them as a whole before the next day starts: `flow-retro`
writes `retros/<date>.md` beside the profile from every run under the profile's run-state directory
(park causes that recur, decisions left open, spend per lane, verdicts overturned) and proposes the
edits that evidence supports. It applies none of them; each proposal comes back as a choice.

## Decisions are questions, never prose

Anything the run leaves for the user goes back as a choice with the options named, each with what it
gains, what it loses and what reversing it costs. A decision buried in a paragraph of a report is
still a decision. When in doubt whose call it is, it is theirs.

**A harness block is its own kind and goes to nobody.** A phase stopped by a classifier or a
permission denial parks with the blocking rule quoted; no answer would unblock it, so it is not a
question.

## Tests

`bash skills/flow-run-ticket/tests/run-tests.sh` runs the contract check and the dry-run suites of
the ticket and day drivers. They simulate every lane and every script; nothing reaches a forge, a
tracker or a model.
