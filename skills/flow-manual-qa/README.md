# flow-manual-qa

The half of verification no automated level reaches: which acceptance criteria actually need a human,
steps that can fail, a verification record on the ticket, and the cross-ticket register of what nobody
has verified yet.

## Where it sits

| | flow-tdd | flow-confidence-check | **flow-manual-qa** |
|---|---|---|---|
| Names | criteria no test level reaches | findings marked `needs-user` | — |
| Executes | — | — | the naming, per criterion |
| Remembers | — | — | across tickets, in the register |

A project's automated QA lane, when its profile lists one in `## test toolchain`, is a hand-off target
for the `automatable` bucket, never a dependency.

## Profile facts it reads

| Fact | Section |
|---|---|
| QA statuses, tracker kind, project key | `## tracker`, `## identity` |
| hosts, surface map, deployed-SHA reading, test users, QA browser and evidence directory | `## environments` |
| what a merge reaches | `## release` |
| register path (optional; absent or `none` → rows stay on the ticket) | `## verification register` |
| known bugs | `## known issues` |
| protected paths and records | `## merge authority`, `## inviolables` |
| who decides what this skill may not | `## escalation` |

`## verification register` is rendered as `verificationRegister` by `lib/profile-facts.sh` and checked
by `--check`: a `TODO`, or a Path line with no code span, refuses the profile.

## Design notes

- Every project fact the procedure needs - hosts, the surface map, QA statuses, the register path, the
  QA browser and its origin scope, the tracker kind - comes from the profile. `Kind: none` routes
  records to the spec file.
- Decisions the skill may not take go to the ticket's owner or the `## escalation` human, never to a
  named person.
- `automatable` criteria route to `flow-tdd` or the profile's own QA lane.
- Browser-only checks live in `references/browser-evidence.md`; generic simulated-user rules live in
  `references/simulated-sessions.md`, while project-specific simulation (models, personas, scripts)
  stays in a project skill.
- "Never moves a ticket to Done" is generalised to "any forward status", since boards name statuses
  differently.
- A protected write is anything under a non-`agent` `## merge authority` path or an `## inviolables`
  item.
- `scripts/check-artefacts.mjs` follows the script I/O contract in `docs/harness.md`; its tests run
  with `node --test 'skills/flow-manual-qa/scripts/tests/*.test.mjs'`.

## Rules earned in field use

Each rule below was added after a real verification pass went wrong without it.

- The gap is detection, execution and memory
- A green CI job proves a build, not a rollout
- Surface before SHA
- Deployed is not reachable; name the path from user action to code
- Containment in the served artefact beats containment in git
- A code-split route file is a stub
- Re-establish Step 0 when time has passed
- Verify the instrument, never on the prompt's say-so
- Confirm the bundle from the browser; read argv over config
- Unconfirmed environment → `not verified`, never `failed`
- Five buckets, `automatable` hands to a test
- Not satisfiable as written is a ticket defect
- Step 2 generators
- "Unchanged" needs a captured baseline
- Verdict states, three tests before ranking
- Record the observation that undermines the hypothesis
- `observed-by-agent` needs an artefact
- Artefact exists, is not empty, and is newer than the run start — checked by
  `scripts/check-artefacts.mjs` before the record is posted
- Subtract own requests from the console log
- Read at the consumer boundary, not the transport
- Correct by striking, not appending
- One register, not verifiable yet, rewrite the blocker
- Re-measure a blocker when reporting it
- A descope is corrected everywhere
- Spec disagrees with itself → stop; surface full-coverage cost
- Origin scope is not widened by a step
- One owner per charter section
- Occluded window, `element.click()` fallback
- A proxy is not a test — modelled / proxy / not modelled; intent is not effect; a proxy that decides a gate makes it `not verified`
- A stubbed backend is not the environment
- The recorded timeline is the only source of a verdict
- App-vs-oracle triage; rerun before a defect; harness failure is `not verified`
- Simulation red flags

## Pending, not applied

- A sixth Step 1 bucket for a criterion that grades the tickets this ticket blocks. It changes the
  classification, so it waits for a decision rather than riding a port.
