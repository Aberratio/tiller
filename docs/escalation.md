# Escalation

What happens when a run cannot proceed on its own. The chain is the same for every project; only the
lists and addresses come from the profile.

```
source cascade  →  resolver  →  owner proxy  →  human
(the phase)        decides      acts within     signs, and answers
                   or parks     a mandate       what nobody else may
```

A harness block — a tool, permission or classifier refusal — skips the chain and goes to nobody.

## Roles

| Role | Skill | Does | Never |
|---|---|---|---|
| source cascade | the phase itself | answers from repo docs, ticket and comments, PRs, ledger; records the answer in the ledger | — |
| resolver | `skills/flow-resolver` | researches in a fixed order, weighs, decides with the reversal cost; parks on an inviolable or a signature | edits code, acts, posts, signs |
| owner proxy | `skills/flow-owner-proxy` | takes a step needing the owner's mandate, only from the profile's closed mandate list; acts and reports | signs, writes to a hard-stop channel, starts its own work |
| human | the role in `## escalation` | signs the ready-to-sign list; answers what the proxy may not | — |

A driver lane with `agentType` set to a role in `config/agents.json` (`flow-resolver`,
`flow-owner-proxy`, `flow-pm`) gets that agent inline through `claude -p --agents`: the prompt is the
role's `SKILL.md` body, the tools are the config allowlist plus `StructuredOutput` (without it
`--json-schema` returns no result), and `$TILLER_HOME` is named as a literal path, because auto
permission mode refuses a command that expands a variable. Nothing is installed into `~/.claude/agents`;
any other `agentType` passes through as `--agent` to an installed agent. The lane's `--model` overrides
the config `model`, which applies only when the role runs without one.
`harness.mjs args` sets `agents` for a node run only: the resolver lane gets `flow-resolver`, the
owner-proxy lane gets the profile's proxy when that proxy is a role in `config/agents.json` and no agent
otherwise.

`resolvedBy` on a decision record is always one of `source-cascade`, `resolver`, `owner-proxy`, or the
human role — never a person.

## The routine

`lib/escalation/route.mjs` moves one decision one hop per call. It is dependency-free above its CLI
section, so the driver imports it as a plain module; `runChain(input, callLane)` drives it to a terminal route.

```bash
node lib/escalation/route.mjs input.json     # one script-result line; exit 0 whenever routing ran
```

Input: `facts` from `lib/profile-facts.sh` (`inviolables`, `ownerProxy`, `escalation`,
`profilePath`); `decision`, a decision record; `step`, present only when what waits is an action —
`{mandate, what, channel, authority, foreignPr}`; `answers`, the lane outputs gathered so far —
`source`, `resolver`, `owner-proxy`.

The caller sets `step.channel` when the step writes to a channel on the profile's hard-stop list, and
`step.authority` from the gate evaluator's result for a merge.

| Route | Meaning | Record |
|---|---|---|
| `pending` | call the lane in `next` with `brief`, add its output under `answers[next]`, call again | unchanged |
| `decided` | settled by the source cascade or the resolver | `resolved`, `resolvedBy` set |
| `proxied` | the owner proxy acted inside its mandate | `resolved`, resolution is the report line |
| `inviolable-park` | the question touches an inviolable | stays `open`, with the resolver's recommendation |
| `parked-human` | a hard stop, no proxy, a mandate not granted, an unmet condition, or a resolver park on a signature | stays `open`, `human` names who answers |
| `ready-to-sign` | a merge the agent may not make; the PR stays open on the ready-to-sign list | stays `open` |
| `no-escalation` | a kind whose `escalate` is `never`, or a lane that hit a harness block | listed in run state; `harnessBlock` carries the block as its own record |
| `invalid-answer` | a lane output failed its schema (CLI only); the runner's schema retry applies | unchanged |

Writing is the caller's: `state.mjs decide` for a new or parked record, `state.mjs resolve` for a
settled one, and a `doubt` returned with a decision goes to the branch ledger and to `doubt.log`,
through `lib/doubt-log.sh append <doubt.log>` (stdin appended, parent directory created).
`doubt.log` is already resolved; nothing downstream reinterprets it.

## Order of checks

1. `escalate: never` kinds (`kinds.json`) → `no-escalation`; a harness block loses any options it was
   given, because no answer unblocks it.
2. `escalate: sign` → `ready-to-sign`.
3. A harness block inside any lane answer → `no-escalation`.
4. An answer from the source cascade → `decided`.
5. Hard stops on the step: authority not `agent` → `ready-to-sign`; someone else's PR or an outward
   channel → `parked-human`. No agent is called.
6. A question with no mandate step → the resolver. An inviolable named → `inviolable-park`, also when
   the resolver claims not to park or names an item the profile does not declare. A park on a
   signature → `parked-human`. A decision with no `mandate` → `decided`.
7. A mandate — from the step or from the resolver's decision — outside the closed vocabulary, with no
   owner proxy, or not in the profile's list → `parked-human` without calling the proxy.
8. The owner proxy. A park, an action on another mandate, or an unmet condition → `parked-human`;
   otherwise `proxied`.

## Profile sections read

| Section | Used for |
|---|---|
| `## inviolables` | the resolver's parks; an item cited that the profile does not declare still parks, and the reason says so |
| `## owner proxy` | whether step 3 of the chain exists, and its closed mandate list; missing or `none` means no proxy and no unattended day run |
| `## merge authority` | the hard-stop paths, through the gate evaluator |
| `## escalation` | the doubt log and the human role |
| `## run policy` | the stop hour the owner proxy honours |

The mandate vocabulary, the outward channels and the park reasons are closed lists in
`lib/contract/kinds.json`.

## Strict defaults

- Hard-stop channels are every outward channel unless the profile narrows them.
- A path whose authority is `human`, `unconfirmed`, or matched by no row is a hard stop.
- Merging a PR someone else authored is a hard stop.
- Whatever cannot be read counts as its strictest value.

## Tests

```bash
lib/escalation/run-tests.sh
```

Scenario fixtures in `lib/escalation/tests/fixtures/scenarios.json` pair profile facts and a decision
with stubbed lane answers and the expected route and lane calls.
