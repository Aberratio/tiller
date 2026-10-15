# Verdict mode — "is this still a bug?"

The question is not *what causes it* but *whether it is still alive*. It arrives as a months-old
report resurfacing: a Slack thread from April, a crash nobody reproduced locally, a repo that may
not even be checked out on this machine. The reproduction gate does not apply — there is nothing
to reproduce and possibly nothing to fix. **The evidence trail is the instrument.**

Work it in this order.

## 1. Separate what was observed from what was guessed

Go back to the original report and split it in two: the observations (stack frame, crash type,
device, build, frequency) and the hypotheses the reporter attached to them. They are usually
written as one paragraph and they are not the same thing.

This matters more here than anywhere else in diagnosis, because the artifact trail you are about
to follow was *built on the reporter's hypothesis*. In the case this mode came from, the original
theory (background release of native resources) was wrong; the real cause was a double-invoked JS
callback in a third-party audio library. Two tickets implementing the original theory ended as
Won't Do — following them would have "proven" the bug unfixed.

## 2. Follow the artifact trail forward from the report date

- Slack threads after the report — including the ones that never got a ticket
- The ticket chain, forwards and sideways (KEY-1 → KEY-2 → KEY-3): duplicates, blockers,
  "Won't Do" siblings
- PRs and release notes touching the named component, and dependency removals — a library dropped
  in a major release fixes every bug it owned, silently
- Incident log entries
- Crash / error telemetry: is the signature still arriving, and since which release?

## 3. Check for recurrence *after* the claimed fix date

The interesting window is the one after the fix shipped, not before it. Absence of reports in that
window is evidence; absence of reports overall is a reporting gap.

Name the window explicitly ("no SIGABRT with this signature since 3.0, released 12 May, ~40k
sessions"). A window nobody states is a window nobody can challenge.

## 4. Answer with the confidence basis attached

Three different answers, never collapsed into "fixed":

| Basis | What it means | What it is worth |
|---|---|---|
| **Test-proven** | A loop went red before the fix and green after | Strongest; the regression is locked down |
| **Telemetry-proven** | The signature stopped arriving after a named release, over a named window | Strong for crashes and errors; blind to anything unreported |
| **Merely claimed** | A ticket says fixed, or someone remembers fixing it | Not evidence. Say so plainly |

State the caveats in the same breath: what the evidence cannot see (unreported failures, cohorts
with no telemetry, an environment nobody checked).

## 4b. The "it disappeared" variant — date the writer before hunting the deleter

A second shape arrives in this mode and reads nothing like a months-old report: **"X is gone,
only the newest one is left."** It is a verdict question too — *was it ever there?* — and it has
one specific trap: "disappeared" is the reporter's hypothesis, not their observation. The
observation is only *"I see one row."*

Order that answers it fastest:

1. **Read the deployed environment's own listing API before reading any code.** It is the loop,
   it costs one `curl`, and it needs no repo checkout. Read the *neighbouring* stores too — if
   two dirs share a volume and one is intact, wipe/PVC/retention theories are dead on the spot,
   and that is most of the hypothesis space gone in one command.
2. **Date the write path in git** (`log -S'<endpoint>' --diff-filter=A`). If the feature that
   writes the record post-dates the data the reporter is missing, nothing was lost — it was never
   written. Compare that merge timestamp against the surviving artifacts' timestamps and state
   whether any gap is left unexplained.
3. Only if a genuine gap survives both is there a deletion to hunt.

Doing this in the other order is expensive: reading planning docs for a deployment area will
happily hand you a deleted-PVC theory that is a *future ticket*, not a shipped change, and it
looks like a diagnosis. Orientation reads (Step 1) are still allowed here — but for a deployed
environment they rank *below* querying that environment, because the environment answers the
question and the docs only describe intent.

Confidence basis for this variant is its own row: **environment-proven** — the live listing plus
the dated write path, cross-checked with no unexplained gap. Stronger than "merely claimed",
weaker than test-proven (it proves what is there now, not that the writer cannot silently fail).
The follow-up to hand the user is the falsifier: *the next session must produce a row; if it does
not, that is the real bug.*

## 4c. The "it suddenly works" variant — cross the artifacts with the configs

The third shape: **"it counted/passed/loaded correctly this time — did we change something, or
was it me?"** It is a verdict question (what changed?), and its trap is the opposite of 4b's:
here the reporter's hypothesis is usually *too generous to the code*. Two things have typically
changed at once — something shipped, and the person did the thing differently — and a single
before/after comparison cannot separate them.

What separates them is a **cross-product, not a diff**: replay every artifact you have (the old
failing runs *and* the new good one) through every config (the old one *and* the one that is
live now). Four cells minimum. The cause is whichever axis moves the numbers. Very often the
shipped change turns out to be a *handicap the user overcame*, which is a completely different
answer from "we fixed it" and the only one that survives the next session.

Three rules that made that cheap:

1. **Date the config from the artifact, not from git.** Stored runs frequently embed a snapshot
   of the config they executed against (`reference_meta`, a build sha, a settings blob). Reading
   that field across the run history dates the change to the minute and names it exactly, with no
   deploy archaeology. Do this before `git log`.
2. **Rule out anything that shipped by re-running today's code over the old artifact** — never by
   deploy timing. A classifier that merged 30 minutes before the "bad" run sits inside the deploy
   window and timing cannot settle it; recomputing its output over the stored inputs settles it in
   one command.
3. **Verify the good result independently before explaining it.** "It counted 10" may mean the run
   *stopped* at 10 (a target, a page size, a rate limit), not that 10 was correct. Reconstruct
   ground truth from the raw artifact — here, ~17 real events behind 10 counted ones. A verdict
   that accepts the happy number and explains it is worse than no verdict.

Confidence basis: **differential-proven** — the cross-product ran, and the cells disagree in a way
that isolates one axis. Say which cells you did not have (a missing old artifact, a config you
could not reconstruct) in the same breath.

## 5. If the verdict is "still alive"

You are back in the main skill at Step 0, with the deliverable set to a fix or a plan, and the
trail you just built is your orientation read — it has usually already named the code path.
