# flow-brainstorm — where it sits

**What it splices.** It comes before a ticket exists:

```
flow-brainstorm  →  flow-write-ticket  →  flow-plan-ticket  →  flow-tdd
        └──────→  flow-discovery (a new project; the brain already holds the decision)
```

| | flow-brainstorm | flow-plan-ticket | flow-discovery |
|---|---|---|---|
| starts from | a goal or a problem | a written ticket | a new project |
| ends in | one recorded decision | an implementation plan | a spec and a roadmap |
| needs a profile | no | yes | no |
| writes to | brain, ledger or doubt log | the ledger | the brain |

No other skill depends on this one. Pointer lines in other skills and in the top-level README are
left to those files' owners.

**What makes it fire.** Its description, plus whatever routing the install adds.

## Decisions

- **No profile is not a stop.** A brainstorm often comes before a project exists, as with
  flow-discovery. Without a profile and a register, the outcome is reported as "nowhere durable" with
  the command that would make it durable.
- **Destination ladder:** a brain with `decisions.md` and write access, then the ticket's decision
  ledger, then the profile's doubt log. A brain without `decisions.md` is knowledge, not a register.
  On a ticket branch with a brain, the ledger line is written too, because reviews read only the
  ledger. Never a tracked spec file.
- **The brain record** is `proposed` by default. It is `agreed` with `--confirmed-by self` only in a
  pet brain and only when the human chose; in a client brain `--confirmed-by` is refused, because
  confirmation there is the client's. Each assumption becomes a `Q-nnn` owned by `me`; `flips: true`
  sets `Blocks spec: yes`. The session file lives in the brain's `brainstorms/`.
- **"Materially different" is enforced structurally:** no two options share their strongest case
  against, and one option is `minimal` (doing nothing counts). Wording similarity is not checked.
- **A hybrid is never a recommendation.** It is another option with its own objection and cost.
- **A reversal cost needs a number.** "Low" is refused.
- **`touches` vocabulary:** `## <profile section>`, `inviolable: <title>`, or `none` alone.
  `--facts` checks inviolable titles and `--profile` checks section headings. A recommendation that
  touches an inviolable passes with a `park:` line; that choice belongs to the human.
- **The doubt-log entry format is defined here** (`render --as doubt`), since the doubt log had none.
- **`render --as awaiting` uses kind `question`**, in the lane's `awaiting[]` shape.
- **The script never runs git.** The skill commits the brain, so the script stays testable without
  a repository.
- **No sub-agents.** One session is enough to diverge and converge, and the script does the format
  checks.
- **Long measured output is clipped visibly** (`… (clipped; N chars)`) at 160 characters.

## Where it came from

The skill was tested against a baseline: the same task, run by an agent without the skill. The
baseline gave five options. It gave no reversal cost and no touched section for any of them, and
included no minimal option. Its recommendation was a hybrid with no named runner-up, and it went on
to implementation steps. It proposed a tracked spec file, counted doc reads as verification of
code, and asked four questions at once.

With the skill, a run gave four options with a minimal one and a named runner-up. It marked one
assumption as `flips`, and the checker passed. It correctly picked "nowhere durable", because the
granted brain had no `decisions.md` and no profile resolved. That run found six gaps, which are now
closed:

- the `decisions.md` probe is now explicit;
- "someone can answer" is now defined;
- inferred claims are labelled as assumptions;
- a fallback was added for runtimes that refuse commands with variables;
- section names are checked with `--profile`;
- output is clipped visibly.

## Requirements

- node 18 or newer
- the discovery library, for the brain rung

## Tests

```bash
bash skills/flow-brainstorm/scripts/run-tests.sh
```
