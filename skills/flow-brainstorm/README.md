# flow-brainstorm - where it sits

It comes before a ticket exists:

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

No other skill depends on this one. It fires on its description, plus whatever routing the install
adds.

## Decisions

- No profile is not a stop, since a brainstorm often comes before a project exists. Without a
  profile and a register, the outcome is reported as "nowhere durable" with the command that would
  make it durable.
- Destination ladder: a brain (the project's knowledge repo) with `decisions.md` and write access,
  then the ticket's decision ledger, then the profile's doubt log. A brain without `decisions.md`
  is knowledge, not a register. On a ticket branch with a brain, the ledger line is written too,
  because reviews read only the ledger. Never a tracked spec file.
- The brain record is `proposed` by default. It is `agreed` with `--confirmed-by self` only in a
  pet brain and only when the human chose; in a client brain `--confirmed-by` is refused (the
  client confirms). Each assumption becomes a `Q-nnn` owned by `me`; `flips: true` sets
  `Blocks spec: yes`. The session file lives in the brain's `brainstorms/`.
- Options must differ materially: no two share their strongest case against, and one is `minimal`
  (doing nothing counts). Wording similarity is not checked.
- A hybrid is never a recommendation. It is another option with its own objection and cost.
- A reversal cost needs a number. "Low" is refused.
- `touches` vocabulary: `## <profile section>`, `inviolable: <title>`, or `none` alone. `--facts`
  checks inviolable titles and `--profile` checks section headings. A recommendation that touches an
  inviolable passes with a `park:` line; that choice belongs to the human.
- The doubt-log entry format is defined here (`render --as doubt`).
- `render --as awaiting` uses kind `question`, in the lane's `awaiting[]` shape.
- The script never runs git. The skill commits the brain, so the script stays testable without a
  repository.
- No sub-agents; one session diverges and converges, and the script does the format checks.
- Long measured output is clipped visibly (`… (clipped; N chars)`) at 160 characters.

## Where it came from

The skill was tested against a baseline agent running the same task without it. The baseline gave
no reversal costs, no touched sections and no minimal option, recommended a hybrid with no
runner-up, and proposed a tracked spec file. With the skill, a run produced four options including a
minimal one, a named runner-up and a `flips` assumption, and correctly reported "nowhere durable".
The gaps that run found are closed: an explicit `decisions.md` probe, a definition of "someone can
answer", inferred claims labelled as assumptions, a fallback for runtimes that refuse commands with
variables, section names checked with `--profile`, and visible clipping.

## Requirements

- node 18 or newer
- the discovery library, for the brain rung

## Tests

```bash
bash skills/flow-brainstorm/scripts/run-tests.sh
```
