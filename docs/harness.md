# Harness contract

The unattended runner is three layers: deterministic scripts (bash or node, tested, no model),
the Node driver (`lib/driver/`: phases, counters, gate arithmetic, journal), and agents (judgment
only). The driver runs a script in its own process and reads one JSON line back; every value it
gets has a schema here.

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
from the profile. Every cap needs a consumer in a script under `lib/` or `skills/`; the self-check
fails on a cap only `kinds.json` or a test names.

**`ci-infra`** is retried as transport (backoff up to `backoffAttempts`) when a lane failure classifies
as it. The CI wait reports cancelled and timed-out checks as red, so no CI rerun exists to cap.

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
- A gate lane's ladder steps sideways or up only: the next candidate sits at the failed model's tier
  or above (`maxLadderSteps` 1), never below. A non-gate lane climbs its cost order one step.
- `second-opinion` is a gate lane routed with `avoid: <model of the contested output>`: another
  admitted model at that tier or above goes first; with none, the same model answers and the route
  record carries `sameModel: true`. Its verdicts downgrade a finding only with a reason and
  evidence, never raise one, and never widen merge authority. Called at most `caps.secondOpinions`
  (1) times per run: when two review axes disagree on a file or the fix rounds run out.
- A measured score (`config/measured.json`, generated by `calibrate` and git-ignored) only demotes. One below the hand score in `models.json`
  replaces it; one above is ignored; a pinned model with no hand score takes a measured score only
  when that score fails the lane. A pinned model measured below `gateFloor` is dropped from that
  gate lane with one stderr line per model, lane and eval run; the route record says
  `measured:<evalRun>` on every demoted candidate.
- The routing state is read at launch from the journals under the profile's run-state directory
  (`~/.claude/run-state/<profile>`, or `TILLER_RUN_STATE`; an explicit `--root` reads only itself):
  `recent` mean tokens per model and lane (input plus cache writes in, output out, replayed lines
  left out) and `cooldown` for every model rate-limited within `caps.cooldownMinutes` (15). A rate
  limit during the run cools that model for the same window; a cooldown every candidate shares is
  lifted rather than parking the lane. Each lane journal line carries `at`.

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

`lib/driver/drive.mjs` runs one ticket; `lib/driver/day.mjs` runs waves of them on one `STATE_ROOT`,
each ticket in its own `drive.mjs` process. Neither reads a profile: both take the args object
`skills/flow-run-ticket/bin/harness.mjs` builds (`args`, `day-args`) and are launched through it
(`drive`, `drive-day`). An args file that still names the retired Workflow runner is refused.

| Command | Produces |
|---|---|
| `args --profile --date (--ticket KEY \| --spec path)` | `<root>/args-<ticket>.json`; `--spec` only when the tracker is `none`; `--summary` makes the branch `<KEY>-<kebab of it>` |
| `day-args --profile --date --queue waves.json` | `<root>/args-day.json`; refused without an owner proxy, a day ceiling or a valid queue |
| `drive --args` / `drive-day --args` | a ticket or a day on the Node driver; one script-result line, the result in `driver-result.json` / `day-result.json` |
| `supervise-env --profile [--disallow tool]...` | `SUPERVISE_STOP_HOUR` and `SUPERVISE_DISALLOWED_TOOLS` for `lib/supervisor/supervise.sh` |
| `calibrate --profile [--root dir] [--out file] [--min-n N] [--dry-run]` | `config/measured.json` from every `verdicts.jsonl` under the profile's run-state directory; one script-result line naming the pairs measured and the pairs skipped for too few verdicts |
| `run`, `classify`, `sleep`, `write`, `push`, `command`, `resume`, `base-head` | what the exec lane invokes during a run; see the file header |

Args carry the rendered facts, the lane schemas, model tiers resolved through
`lib/routing/resolve.mjs` (a profile override moving a gate lane below T3 refuses the launch, as does a
tier that lists no model), review-bot skip patterns,
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

**Cost caps.** `config/routing.json` `budgetsUsd` holds the per-call cap of each tier plus `run` and
`day`. The Node driver makes a lane call only while the ticket's recorded spend (every run in its
driver journal), the per-call caps of calls still in flight and this call's cap stay within `run`;
otherwise the run parks as `budget-exhausted` with one open decision. Replayed steps are not counted
again. Without `run` in the args there is no run cap. Before each chunk, the day driver adds what the
queue's tickets and the day's own lanes recorded to the run cap each chunk ticket has left; over `day`,
the chunk does not start and the day parks as `budget-exhausted`. Defaults: `run` 75 (five T3 calls),
`day` 450 (two chunks of three capped runs).

**Supervisor.** `lib/supervisor/supervise.sh` gives every `claude -p` child `--max-turns`
(`SUPERVISE_MAX_TURNS`, default 120) and `--max-budget-usd` (`SUPERVISE_MAX_BUDGET_USD`, default
`budgetsUsd.run`, or 75 when `config/routing.json` has none). With `SUPERVISE_MAX_SPAWNS`, that bounds
a supervised run at spawns × the per-child budget.

**Retro.** `skills/flow-retro/bin/retro.mjs --profile <file> [--root dir] [--date d] [--dry-run]` reads
every `driver-result.json`, `day-result.json`, `decisions.jsonl`, driver journal and verdict ledger
under the profile's run-state directory and writes `retros/<date>.md` beside the profile: runs, park
causes, open decisions, spend, overturn rates, then proposals with evidence lines. A proposal targets
a profile section, a cap, a lane schema or the run-ticket skill, never merge authority, inviolables
or the owner-proxy mandate; nothing is applied.

**Doctor.** `bin/doctor [--json] [--dir <dir>]` prints one verdict line (`ok`, `warn`, `fail`) per
requirement: Node at or above the floor in `lib/doctor/doctor.mjs`, git, bash, jq (with the scripts
that call it), `TILLER_HOME` pointing at a checkout; optional and only warned: gh (PR phases), the
`claude` CLI (without it, dry runs only), codex, `caffeinate` or `systemd-inhibit` (keep-awake), the
profile resolved for the directory, and the role files under `~/.claude/agents`. Exit 0 when every
required check passes, 1 otherwise.

Tests: `bash skills/flow-run-ticket/tests/run-tests.sh` (contract check plus both dry-run suites).
Node 20.11 or newer is required. Give `node --test` file globs (`'lib/<dir>/tests/*.test.mjs'`), never a
directory: Node 24 loads a directory argument as a module and fails.

## Config and run records

| File | Purpose |
|---|---|
| `config/routing.json` | tiers (`T1`-`T3` one model each; `T4` an optional model list, empty until a profile needs it; `T0` appears only in spend records, for exec and script lanes that never run a model, and is never routed) and each lane's tier and gate flag |
| `config/models.json` | each model: runtime, model id, status, context window, features, data policy; no price |
| `config/lanes.json` | each lane's needs and caps (capability floor, context, cost per call, ladder steps) and the escalation rules |
| `config/prices.json` | the only price table: USD per million tokens per `<runtime>/<model>`; an active model with no entry is refused at launch, an `"unverified": true` entry only warns, and a model with no entry is never routed or run under a USD budget; `limits.maxTurns` and `limits.wallClockMs` bound every Node-driver lane call |
| `config/mcp-servers.json` | the connector name each runtime uses for a logical MCP server; a lane request's `mcpServers` overrides it |
| `config/hitl-words.json` | stopwords per language (L19) and state words (L15) for the hitl linter; lint options extend both |
| `config/measured.json` | `{ "<model>": { "<lane>": { score, n, evalRun } } }`, written by `calibrate` (`lib/journal/calibrate.mjs`): `score` is one minus the overturn rate over `n` verdicts, at least `--min-n` (10); machine-local and git-ignored; `TILLER_MEASURED` names another file |
| `schemas/route-decision.json` | one journal record per routed dispatch: the model chosen for a lane call and why the others were not |
| `schemas/hitl-request.json` | anything put to a person; `lib/hitl/lint.mjs` enforces its wording before it is sent |
| `tickets/<ticket>/verdicts.jsonl` | append-only lane verdicts plus `overturned` lines; read as an overturn rate per lane and model |
| `lane-inputs/<ticket>/<label>.json` | the exact input of each lane call, with secrets redacted; a failed capture is a journal warning, not a lane failure |

## Changing the contract

Adding a kind, lane, field or schema: edit `kinds.json` or the schema, add fixtures, run the
self-check. Renaming or removing breaks every consumer and needs all of them changed together.

## Untrusted text

Text the harness did not write (the ticket body and comments, PR, review and bot comments, CI
output) is data, never instructions. When the driver pastes such text into a prompt it goes through
`lib/text/untrusted.mjs`: a fixed preamble, then the text between `<<<UNTRUSTED source=… id=…>>>` and
`<<<END UNTRUSTED id=…>>>`, where the id is a hash of the content and any `<<<`/`>>>` inside is
broken up, so the content cannot close its own fence. A lane that reads such text itself (the
tracker, bot threads, CI logs) gets `UNTRUSTED_READ_RULE` in its task instead. Lines that read as
orders to the agent are recorded as `suspicious[]` (source, line, quoted text, reason) on the phase
output (`plan`, `ci`) and logged; they never stop a run on their own.

## Security scan

`lib/security/scan-diff.mjs --repo --base --head [--profile]` runs at the start of every confidence
pass, before the model dimensions, on the pinned base and the current head. It reports credential
shapes added by the diff (the patterns of `lib/leak-guard.sh`; location only, never the value) as
blocker, each changed dependency manifest or lockfile as medium, and a failing profile audit command
(`## security`, `- Audit command:`) as high. Its findings join the confidence list without a reverify
lane; blocker and high ones go to the fix round like any confirmed finding, and the scan re-runs on
the fixed head. A scan that does not answer (exit 1, no findings list) and an audit command that
cannot run are held as harness findings and block the gate's `harness` condition. The dimensions are
told what the scan covered. The result is `out.confidence.securityScan`.
