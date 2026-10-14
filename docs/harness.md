# Harness contract

The unattended runner is three layers: deterministic scripts (bash or node, tested, no model),
Workflow scripts (pure JS: phases, counters, gate arithmetic), and agents (judgment only). A
Workflow script has no filesystem, no shell and no clock, so it reaches a script only through the
exec lane, and every value it gets back has a schema here.

| File | Holds |
|---|---|
| `lib/contract/exit-codes.md` | exit code ↔ `status` table |
| `lib/contract/kinds.json` | the closed vocabularies: statuses, failure kinds, harness default caps, lanes, phases, tiers, run and decision statuses |
| `lib/contract/schemas/*.json` | script result, exec-lane result, one output schema per agent lane, state records, phase-spend record, gate result |
| `lib/contract/fixtures/<schema>/` | `valid-*.json` must pass, `invalid-*.json` must fail |
| `lib/contract/validate.mjs` | self-check, and a validator other scripts call |

```bash
node lib/contract/validate.mjs                                  # self-check; last line PASS or FAIL
node lib/contract/validate.mjs script-result out.json --exit 3  # one document, prints one script-result line
```

## Script I/O

- Invoked by absolute path with arguments only. No prompts, no stdin required.
- **stdout is exactly one JSON line** that validates against `schemas/script-result.json`. Reserved
  keys: `status`, `kind`, `reason`, `retryAfter`, `artifact`. Every other key is the script's
  payload, documented in the script's header.
- The line stays under `caps.execStdoutBytes` (4096 B), because an agent copies it verbatim. A
  larger payload goes to a file whose absolute path is `artifact`.
- stderr is free text for humans and is never parsed.
- Exit code and `status` name the same row of `exit-codes.md`. A measurement that comes out red
  (CI failed, claim does not match) is `ok` with the result in the payload; `blocked` means the
  script could not answer.
- `kind` is required unless `status` is `ok` or `pending`, and its `exit` in `kinds.json` equals the
  exit code. Kinds with `exit: null` are raised by the runner, never by a script.
- Waits block for at most `caps.waitCiSeconds` per call, then exit `pending`.
- Run state lives under the directory in `STATE_ROOT`; scripts take it from the environment and
  never compute it. When `STATE_ROOT` is unset, the runner resolves it to
  `~/.claude/run-state/<profile>/<run>/`; the quota file sits one level up, at
  `~/.claude/run-state/<profile>/`, shared by every run of that profile.
- Tests are hermetic: `gh`, `git` and `claude` are stubs on `PATH`, fixtures sit next to the tests,
  no network. `lib/onboard` is the exception for `git`: detection reads git's own output, so its
  tests build throwaway repos with the real binary.

## Failure kinds

Every failure and every park carries a `kind` from `kinds.json`; nothing is free text. Per kind:

| Field | Meaning |
|---|---|
| `exit` | exit code a script uses when it ends with this kind; `null` = runner-only |
| `escalate` | `never`: listed in run/day state only. `chain`: resolver, then owner proxy, then human. `sign`: ready-to-sign list, a human signature only |
| `ceiling` | whether an open decision of this kind counts toward the day ceiling |
| `agentMayEmit` | whether an agent lane may put it in `awaiting[]`; every other kind is derived by a script |
| `retry` | `mode` plus a fixed `max` or a `cap` key into `caps` |

`caps` are harness defaults. A profile's `## run policy` may lower `fixRounds` and `ciFix` (never
above their `max`); `dayCeiling` and `maxParallel` have no harness default and must come
from the profile.

**`harness-blocked`** — a tool, permission or classifier denial. Detected from an error with
permission or classifier text, or an exec-lane result with `ran: false`. Retried once, identical
(the classifier is not deterministic). If it fails again it becomes a decision record with the
literal denial in `why` and **no options**: nobody is asked, because no answer unblocks it. It is
listed under harness blocks in the day state and excluded from the ceiling. `validate.mjs` rejects
a harness block shaped as a question.

**`usage-limit`** is a pause (`paused-usage`), never a park. A phase that ends parked with no
ledger entry is reclassified by script as `usage-limit`.

**`ready-to-sign`** — a run that reaches a path it may not merge parks with the PR left open and
added to a ready-to-sign list; only a human signature moves it further.

**`budget-exhausted`** — a USD cap from `config/routing.json` `budgetsUsd` would be passed by the
next unit of work. Nothing more is called; the run or day parks with an open decision (raise the
cap and relaunch, or hand the work back). Not retried, outside the ceiling.

**Owner proxy** — a profile's `## owner proxy` section names the proxy role and a closed mandate
list drawn from `kinds.json` `mandates`. The proxy decides only what that list names; no section, or
`none`, means no unattended day run and every mandate step parks for the human. The chain, the
routine that walks it and the lane outputs are in `docs/escalation.md`.

## Exec lane

Lane `exec`, tier T1, one `agent()` call per command, output schema `schemas/lane-exec.json`.
Fixed prompt:

> Run exactly this command with the Bash tool, once, and nothing else: `<command>`.
> Return JSON: `command` as given, `ran`, `exitCode`, `stdout` verbatim (untrimmed, unparsed).
> If the tool call is refused, return `ran: false`, `exitCode: null`, `stdout: ""` and the literal
> refusal text as `denial`. Do not retry, explain, or fix anything.

- The command is one script invocation by absolute path, each argument single-quoted. No pipes,
  `&&`, loops or heredocs: compound commands are refused where the single command passes.
- The runner then checks, in order: the result validates; `command` equals what was sent;
  `ran: false` → `harness-blocked` path; `stdout` parses as one JSON line that validates as a
  script result with this `exitCode`. Any check failing is kind `schema`: one retry on the same
  tier with the error appended, one retry a tier up, then a fail-closed gate condition if the
  value feeds a gate.
- A `pending` result is re-called at most `caps.waitCiRecalls` times, then `ci-timeout`.

## Agent lanes

- Each lane in `kinds.json` has `schemas/lane-<lane>.json`. All share `questions[]` (the resolver
  may still settle it), `awaiting[]` (a human or nobody) and `notes`. An `awaiting` item other
  than `harness-blocked` carries at least two `options`, a `recommendation` and a `reversalCost`.
- A claim that feeds a gate (`testResult`, a head SHA, a finding closed) is re-derived by a script
  before any gate reads it. The schema carries the claim; the script decides.
- Every schema stays under `caps.schemaBytes` (3500 B, compact JSON): larger output schemas are
  refused by the classifier non-deterministically.
- Every `agent()` label is `<phase>:<lane>:<tier>[:<detail>]`, e.g. `review:review-axis:T3:standards`,
  so spend joins to phases exactly.

## State records

| Schema | Written by | Read by |
|---|---|---|
| `checkpoint` | the state CLI after each phase, before the next starts | the runner on resume (`startPhase` + stored outputs) |
| `decision` | the state CLI, to the day decisions file and the branch ledger | open-count, day summary, resolver |
| `run-state` | the state CLI; counters survive resume | runner, supervisor |
| `quota` | review-bot check | every run of the same profile |
| `phase-spend` | journal join over run journal + transcripts | spend report, routing review |
| `gate-result` | gate evaluator | runner, merge script |

Open-count is the number of `decision` records with `status: open` whose kind has `ceiling: true`,
minus the profile's exclusions, across the whole decisions file. `resolvedBy` is a role, never a
person.

## Facts keys fixed here

`facts.modelRouting` — object `lane → tier`, rendered from the profile's `## model routing`. Other
facts keys belong to `lib/profile-facts.sh`.

## Runners

`skills/flow-run-ticket/run-ticket.workflow.js` runs one ticket; `skills/flow-run-day/run-day.workflow.js`
runs waves of them as child workflows on one `STATE_ROOT`. The Node drivers do the same without an exec
lane: `lib/driver/drive.mjs` runs one ticket, `lib/driver/day.mjs` runs the waves with each ticket in
its own `drive.mjs` process. `driver` in the args picks one; `node` is the default. None reads a
profile: all take the args object `skills/flow-run-ticket/bin/harness.mjs` builds.

| Command | Produces |
|---|---|
| `args --profile --date (--ticket KEY \| --spec path)` | `<root>/args-<ticket>.json`; `--spec` only when the tracker is `none`; `--summary` makes the branch `<KEY>-<kebab of it>` |
| `day-args --profile --date --queue waves.json` | `<root>/args-day.json`; refused without an owner proxy, a day ceiling or a valid queue |
| `drive --args` / `drive-day --args` | a ticket or a day on the Node driver; one script-result line, the result in `driver-result.json` / `day-result.json` |
| `supervise-env --profile [--disallow tool]...` | `SUPERVISE_STOP_HOUR` and `SUPERVISE_DISALLOWED_TOOLS` for `lib/supervisor/supervise.sh` |
| `run`, `classify`, `sleep`, `write`, `push`, `command`, `resume`, `base-head` | what the exec lane invokes during a run; see the file header |

Args carry the rendered facts, the lane schemas, model tiers resolved through
`lib/routing/resolve.mjs` (a gate lane is never below the session tier), review-bot skip patterns,
`hardStopChannels`, the caps and the explicit `STATE_ROOT`. Every lane runs under `with-backoff`
and `classify-failure`; a green claim passes `verify-claim` before a gate reads it.

**Hard-stop channels.** `route.mjs` treats every outward channel as a hard stop. The profile's
`Hard-stop channels` prose may narrow that list; the args builder renders it to channel ids from
`outwardChannels`, and a runner drops `step.channel` for a channel outside the list before routing.
An unattended child is denied every op `config/tool-kinds.json` marks `write` with a hard-stop channel
(`role:chat.send`), and the whole server of a kind whose `serverChannels` names one (`role:email`).
They resolve through the profile's `## tools` and through the default kinds both, so rebinding a role or
setting it to `none` never reopens the server it left.

**Result `calls[]`.** Each runner returns one entry per lane call. The launcher appends each as a
journal line `{"type":"result","label","outcome","detail","escalatedFrom"}`: `outcome` is in the
`phase-spend` vocabulary, `detail` the raw outcome, `escalatedFrom` the model of the failed attempt.
`lib/journal/spend.mjs` joins result lines without `agentId` to spawns by label, in order.

**Resume.** Every phase writes a checkpoint; a relaunch with the same args skips finished phases
and restarts the unfinished one. A day relaunch skips finished children and resumes started ones.
A usage limit writes `supervisor: paused-usage <reset>` to `state.md`; a finished day writes
`supervisor: done`. One process per ticket: the driver holds the `ticket-run-<TICKET>` lock under
the state root for the whole run, and a relaunch while another live process holds it is refused
with kind `locked` (exit 4) without touching the run's state. A lock left by a dead process is
broken on the next launch.

Tests: `bash skills/flow-run-ticket/tests/run-tests.sh` (contract check plus both dry-run suites).
Node 20 or newer is required. Give `node --test` file globs (`'lib/<dir>/tests/*.test.mjs'`), never a
directory: Node 24 loads a directory argument as a module and fails.

## Config and run records

| File | Purpose |
|---|---|
| `config/models.json` | each model: runtime, model id, status, context window, price, features, data policy |
| `config/lanes.json` | each lane's needs and caps (capability floor, context, cost per call, ladder steps) and the escalation rules |
| `config/prices.json` | USD per million tokens per `<runtime>/<model>`; a model with no entry cannot run under a USD budget |
| `config/mcp-servers.json` | the connector name each runtime uses for a logical MCP server; a lane request's `mcpServers` overrides it |
| `config/hitl-words.json` | stopwords per language (L19) and state words (L15) for the hitl linter; lint options extend both |
| `schemas/route-decision.json` | one journal record per routed dispatch: the model chosen for a lane call and why the others were not |
| `schemas/hitl-request.json` | anything put to a person; `lib/hitl/lint.mjs` enforces its wording before it is sent |
| `tickets/<ticket>/verdicts.jsonl` | append-only lane verdicts plus `overturned` lines; read as an overturn rate per lane and model |
| `lane-inputs/<ticket>/<label>.json` | the exact input of each lane call, with secrets redacted; a failed capture is a journal warning, not a lane failure |

## Changing the contract

Adding a kind, lane, field or schema: edit `kinds.json` or the schema, add fixtures, run the
self-check. Renaming or removing breaks every consumer and needs all of them changed together.
