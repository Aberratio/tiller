---
name: flow-brainstorm
description: Explore what to build when there is a goal but no ticket and no agreed shape yet - at least three materially different options, each with its strongest case against, what reversing it would cost and which profile section or inviolable it touches, converged to one recommendation over a named runner-up and recorded where the harness keeps decisions. Use when the user says "brainstorm", "what should we build", "what are our options", "how could we approach X", "which way should we go", or names a problem without a solution. Not for a ticket that is already specified (flow-plan-ticket) or for agreeing a whole new project's spec (flow-discovery).
user-invocable: true
---

# flow-brainstorm

A brainstorm ends in **one recorded decision**: an option chosen over a named alternative, with
the reasons and the price of changing it later. It does not end in a plan or in code.

**Rule zero: no claim about the current system goes into the brainstorm unmeasured.** A command
and its output, or the word *assumption* with what would settle it. A doc that describes the code is
a claim too. An option built on an unmeasured "the code already does X" is how a brainstorm talks
itself into the wrong thing.

The script `node "$TILLER_HOME/skills/flow-brainstorm/scripts/brainstorm.mjs"` (below:
`brainstorm.mjs`) checks the session's shape and renders every output from it. The model never
grades its own format. Session shape: `references/session.md`.

## When to use

| The situation | Skill |
|---|---|
| a goal or a problem, no ticket, no agreed approach | **flow-brainstorm** |
| a ticket already written as a spec: objective, criteria, constraints | flow-plan-ticket |
| a whole new project, with a client or alone, ending in a spec and a roadmap | flow-discovery |
| one open area inside a discovery that has several real options | flow-brainstorm, recording into the discovery brain |

## Asking

Ask only what reading did not answer, **one question per message**, multiple choice when the
answers can be listed, recommendation first. If the runtime offers a question tool, use it;
otherwise ask one numbered question in plain text and wait for the reply. Someone can answer when
the session is interactive and the user is present. Otherwise (an unattended run, a sub-agent, or the
user said to go ahead) do not ask: write the gap as an assumption with `settle`, and carry on.

## Step −1 — Resolve the project profile (may be absent)

Read `$TILLER_HOME/skills/_shared/resolve-profile.md` and follow its pre-profile variant. This skill also resolves where the outcome will go:

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .     # the profile file; non-zero = no profile
"$TILLER_HOME/lib/resolve-brains.sh" .      # <name> TAB <read|write> TAB <path>, one per granted brain
```

No profile is not a stop: a brainstorm often comes before there is a project. Never guess a
profile. With one, `"$TILLER_HOME/lib/profile-facts.sh" --profile <file> > "$TMPDIR/facts.json"`
gives `inviolables` and `ledgerPath`; if it refuses, write `{"inviolables": [...]}` by hand from
`## inviolables`. The destination is the **first** rung that applies:

1. **A brain** granted `write` whose path passes `test -f <path>/decisions.md`; a brain without it
   is a knowledge brain, not a register, and does not count. More than one → the one the user
   named, else ask; unattended → skip to rung 2.
2. **The ticket's decision ledger** — a profile resolves and the branch carries a ticket key. Path
   from `ledgerPath`.
3. **The doubt log** — a profile resolves: `"$TILLER_HOME/lib/doubt-log.sh" resolve --profile <file> [<the - Doubt log: value>]`.
4. **Nowhere durable.** Say so in one line, with the command that would make it durable:
   `node "$TILLER_HOME/lib/discovery/discovery.mjs" new <name> --pet`.

On a ticket branch with a brain, the ledger line is written too: the reviews read only the ledger.
No other tracked file: no spec under `docs/`, no ADR, nothing that names a person.

## Steps

1. **Frame the goal.** One sentence that names an outcome, not a solution. When the user named a
   solution ("add a webhook"), restate the outcome it serves; the named solution becomes one option.
   Read before asking: the repo's docs, the brain's register (`discovery.mjs status <name>`), the
   ledger, the ticket. Then ask what is still missing (Asking).
2. **Measure.** For every fact an option depends on, run the command and keep the command and the
   relevant output line. A doc read about code is not a measurement of the code: open the code, or
   record an assumption. A grep that finds nothing is recorded as "grep for X found nothing", never
   as "X does not exist". A conclusion drawn from several measurements is an assumption whose
   `settle` is the trace that would confirm it. If the runtime refuses a command that expands a
   variable, write the path out literally.
3. **Diverge, at least three.** Options are materially different when they differ in where the work
   lives, who or what does it, when it happens, or what is given up. Two options with the same
   strongest objection are one option. One option is `minimal`: the smallest thing that meets the
   goal, including doing nothing, deferring, or changing a setting. A hybrid ("A with B's seam") is
   not a recommendation; it is another row with its own objection and cost. For each option:
   - `against` — the strongest case against it, as its best opponent would put it;
   - `reversalCost` — minutes, hours, files, steps; never "low";
   - `touches` — `## <profile section>`, `inviolable: <title as in the profile>`, or `none`.

   Write it all to `$TMPDIR/brainstorm-<slug>.json`.
4. **Check.** `brainstorm.mjs check <json> [--facts "$TMPDIR/facts.json"] [--profile <file>]` until
   exit 0; `--profile` makes every `## section` in `touches` a real heading of the profile. Fix the
   session, never the output.
5. **Converge.** Weigh in this order, naming any trade: fidelity to the goal, reversibility,
   strength of the evidence (measured beats assumed), the repo's conventions, speed. When the
   evidence is thin, take the more reversible option. Set `recommendation`, `beat` (the strongest
   rival, not the weakest) and `why` (the trade against `beat`). An assumption whose falsity would
   change the answer gets `flips: true`. Check again.
6. **Decide.** Pass the same `--facts` and `--profile` to every command below.
   - Someone can answer (Asking): show `brainstorm.mjs render <json>`, then ask the one question, with the
     options in `--as question` order (or print that render and wait). If the human picks another
     option, it becomes `recommendation` and yours becomes `beat`; check again.
   - Nobody can: the recommendation stands, recorded as `self` and overridable.
   - `check` printed `park:` → the recommendation touches an inviolable and is not yours. Ask; or,
     unattended, record it as proposed and put `render --as awaiting` into the run's `awaiting[]`.
7. **Record**, on the rung from Step −1:
   - brain: `brainstorm.mjs record <json> --brain <path>` (`--confirmed-by self` only when the
     human chose, in a brain without `client.md`), then
     `node "$TILLER_HOME/lib/discovery/discovery.mjs" check <name>` until exit 0, then
     `git -C <path> add -A && git -C <path> commit -m "brainstorm: <goal>"`;
   - ledger: `brainstorm.mjs render <json> --as ledger [--agreed-with "<role>, brainstorm"] >> <ledger>`
     — a role, never a name;
   - doubt log: `brainstorm.mjs render <json> --as doubt | "$TILLER_HOME/lib/doubt-log.sh" append <path>`.
8. **Hand off**, one line: a ticket to write → flow-write-ticket; a ticket to plan → flow-plan-ticket;
   a new project → flow-discovery, whose brain already holds this decision.

## Rationalisations

| Excuse | Reality |
|---|---|
| "Two options cover it" | The third is usually the minimal one. `check` refuses fewer than three. |
| "Best of both: A with B's seam" | A hybrid is a fourth option with its own objection and cost. |
| "The docs say the code does X" | A doc is a claim. Open the code, or label it an assumption. |
| "Reversal cost: low" | An adjective, not a cost. `check` wants a number. |
| "I'll write it up as a spec in `docs/`" | A tracked file outside the ladder. Record on the rung from Step −1. |
| "Three quick questions at once" | One per message. The answer to the first changes the second. |
| "While I'm here, the implementation steps" | Out of scope. Hand off; the planner verifies what you would guess. |

## Output

What the user sees: the rendered table, the recommendation over its runner-up, where it was
recorded (path and `D-nnn`, ledger line, or doubt-log path, or "nowhere durable"), and the hand-off.
