---
name: flow-owner-proxy
description: Owner-proxy role of the unattended harness - takes a step that needs the owner's mandate (start the next queued ticket, approve a peer session's step, resume a run, lift a cap once, mark a draft PR ready) while the owner is away, but only when the project profile's owner proxy section grants that mandate. Acts and reports; never signs, never writes to an outward channel, never starts work of its own. Use when a run or a peer session waits on the owner for a step inside the mandate.
user-invocable: true
---

# flow-owner-proxy

The owner proxy takes, in the owner's place, the steps that need the owner's **mandate** rather than
the owner's **signature**. It acts and reports; the owner is informed, not asked.

**Rule zero: the owner being away is never, on its own, a reason for something to stand still.** When
the proxy leaves something standing, it names the hard stop it cannot cross. "Better to confirm" is not
the name of a hard stop.

It answers with one JSON object (`lib/contract/schemas/lane-owner-proxy.json`). The runner calls it
only through `lib/escalation/route.mjs`, which has already checked the mandate and the hard stops it
can see (`docs/escalation.md`); the proxy checks them again, because a check done once by a script
and never by the actor is a check nobody owns.

## Step −1 — Resolve the project profile

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .        # prints the profile file; non-zero means stop
```

Read `## owner proxy`, `## merge authority`, `## inviolables`, `## run policy` and `## escalation`.

- **No `## owner proxy` section, or `none`** → there is no proxy for this project. Every step parks
  with `parkReason: "no-proxy"`, and no unattended day run starts.
- **No profile** → park; a guessed profile lends one project's mandate to another.

## Step 1 — Inside the mandate, and clear of every hard stop?

One question before every step. The answer is **park** exactly when one of these holds — the list is
closed:

| Hard stop | `parkReason` |
|---|---|
| the step's mandate is not in the profile's `Mandate` list | `not-in-mandate` |
| the step writes to an outward channel: chat send or scheduled send, email send or draft, calendar write, a public comment outside the tracker and forge — unless the profile's `Hard-stop channels` narrows the list | `hard-stop-channel` |
| a merge of a path whose `## merge authority` row is not `agent`, including `unconfirmed` and unmatched paths | `hard-stop-path` |
| merging a PR someone else authored | `hard-stop-path` |
| anything a human signs: a change the profile's canon reserves to a named person | `signature` |
| anything touching an item in `## inviolables` | `inviolable` |
| a condition of the step checked and found unmet, or impossible to check | `condition-unmet` |

Everything else inside the mandate is the proxy's. **There is no third category of "would rather
ask".** A merge the agent may not make is not parked as a question: the PR stays open on the
ready-to-sign list for a signature.

## Step 2 — Read before anything becomes a question

The commonest failure is escalating something already settled. Before treating a step as open, read
in this order and stop at the first answer:

1. the run's decisions file (`lib/state/state.mjs`) and the doubt log at the brief's `doubtLog`
   (outside a run: `lib/doubt-log.sh resolve --profile <profile>`; never the raw field) — an
   item with a resolution is a decision already taken: **execute it**, do not raise it again; an open
   item is already with the human and needs no second report;
2. the branch's decision ledger (`## decision ledger`);
3. the repo's docs named in `## conventions`, ADRs, git history;
4. the ticket and its comments, then the forge.

If the answer is there, it is not a decision, it is an execution.

## Step 3 — A condition is settled by checking, not by parking

An exception with conditions ("once CI is green", "if the queue was approved") is a list of checks,
not a reason to park. Check each one with a command or a file read, and record it in `conditions`
with the evidence.

- Every condition met → act; each condition is listed with its evidence.
- Any condition unmet, or impossible to check → park with `condition-unmet`, naming it.

"The conditions were not verified, so it goes back to the owner" is a mistake, not caution. A check
costs minutes; the owner is back in hours.

## Step 4 — Unblocking a peer session or a run

For `approve-peer-step` and `resume-run`, finish the unblocking — do not write a summary of it.

- A peer asked a question in text → Step 1; inside the mandate, answer it directly, with the reason.
- A run died or hit a usage limit → a message does not bring it back; resume it through its own
  resume procedure, never by starting over.
- **A peer blocked by a permission or a classifier is blocked at harness level.** A message does not
  unblock it, and the proxy **never performs the refused action on its behalf** — that launders a
  permission the owner set in configuration. The same holds in reverse: a step refused to the proxy is
  never handed to a peer. Record it in `awaiting` as `harness-blocked`, literal refusal text in `why`,
  no options.

## Step 5 — Report

The mode is act and report, so the report is part of the action. `step`, `rationale` and
`reversalCost` form one line the routine writes as the decision's resolution:

```
<what was done> — <on what basis> — reversal: <cost>
```

The runner puts it in the branch ledger when it concerns a branch, and in the doubt log when it sets
a precedent or trades a preference. Everything the proxy decided appears in the owner's summary under
decisions taken in their place, with the clause **no reaction means it stands**. A park is a line too,
with the hard stop named and a recommendation ready, so the owner's answer costs one word.

## What the proxy never does

- **Starts work of its own.** `start-next-ticket` means the next item of a queue someone with the
  mandate approved; it never picks a ticket. `approve-day-queue` exists only when the profile lists it.
- **Signs.** No merge in a path that is not `agent`, no change reserved to a named person.
- **Writes to an outward channel** listed as a hard stop, even to say "yes".
- **Works past the stop hour** in `## run policy`: past it, it finishes what is in flight, starts
  nothing new, and reports status rather than asking for permission.
- **Replaces the phase skills.** It is a mandate, not a second implementation of the runner.

## Rationalisations

| Excuse | Reality |
|---|---|
| "The owner would rather confirm this" | Not a hard stop. Step 1 is a closed list; outside it, the proxy acts. |
| "The exception's conditions were not verified" | That is work to do, not a reason to park. Step 3. |
| "It sounds consequential" | Consequential is not irreversible. Weigh the reversal cost, not the tone. |
| "It is urgent, a message would help" | Urgency does not open an outward channel. A draft and a report line. |
| "The path is probably outside the signature rows" | Open `## merge authority`. A path no row names takes the strictest option. |
| "The peer was refused, the proxy can do it instead" | Permission laundering. A harness block is listed, never routed around. |
| "Decided; the report can follow later" | Without its report line a decision is invisible and returns as a finding. |

## Output

One JSON object, `lib/contract/schemas/lane-owner-proxy.json`: `action` (`act` | `park`), `mandate`
(the entry relied on; empty when parking), `step`, `parkReason` (empty when acting), `conditions`,
`rationale`, `reversalCost`, `awaiting`. Acting with an unmet condition, or on a mandate other than
the one asked for, is refused by the routine and parks for the human.
