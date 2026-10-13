# flow-discovery

## Goal

Take a new project from nothing to an agreed specification and a phased roadmap with deadlines,
either with a client or alone (a pet project). With a client, also build an understanding of how
the client works and what they need, and keep a register of conversations and agreements that
shows, for any line of the spec, when it was agreed and on what evidence.

The skill runs before a project has a profile, so it is the step that precedes
`flow-onboard-project`.

## Decisions

| Question | Decision |
|---|---|
| Input | Both: prepare before a meeting and digest notes or a transcript after it; a live interview for a pet project. |
| Storage | Client knowledge and the register live in a brain, `brains/<name>/`. The spec lives in the project repo. |
| End point | An approved spec plus a phased roadmap with estimates and deadlines. Tickets and the profile are handed on. |
| "Agreed" | A decision is `agreed` only after the client confirms the recap; until then it is `proposed`. A pet project confirms with `self`. |
| Shape | One skill with five modes, plus a thin script that checks the register's invariants. |

## Layout

```
skills/flow-discovery/SKILL.md     the procedure: modes, discovery areas, hand-off
lib/discovery/discovery.mjs        new | check | status
lib/discovery/templates/           client.md, decisions.md, questions.md, meeting.md, recap.md
lib/testing/fixtures/discovery/             synthetic brains for tests
```

A brain created by `discovery.mjs new <name>`:

```
brains/<name>/
  client.md                  client only: business model, users, who decides and signs off,
                             constraints (budget, data protection, sector), their vocabulary,
                             preferred channel
  meetings/YYYY-MM-DD-<slug>.md   agenda (prep), source (notes, transcript), digest, register changes
  decisions.md               D-001...
  questions.md               Q-001...
  recaps/YYYY-MM-DD.md       recap e-mail drafts
  spec/                      spec and roadmap while no project repo exists
```

`new` runs `git init` in the brain. Access is granted by the human with
`lib/brain-access.sh _none`; the picker remains the only writer of `brains/access.json`.

## Register format

`decisions.md`, one entry per decision:

```markdown
### D-007 — Payments through Stripe Checkout
- Area: tech
- Status: agreed
- Proposed in: meetings/2026-10-14-kickoff.md
- Confirmed by: e-mail 2026-10-15 "Re: Kickoff recap"
- Supersedes: D-003
```

- `Area`: `scope`, `tech`, `budget`, `deadline`, `other`.
- `Status`: `proposed`, `agreed`, `superseded`.
- `Confirmed by` is required for `agreed`; `self` for a pet project.
- `Superseded by: D-nnn` is required for `superseded`.

`questions.md`, one entry per question:

```markdown
### Q-012 — Who signs off the MVP?
- Area: scope
- Owner: client
- Blocks spec: yes
- Opened in: meetings/2026-10-14-kickoff.md
- Closed in: -
```

## Modes

1. **prep** (before a meeting). Read `client.md`, the register and the open questions; write an
   agenda into a new meeting file, with questions ordered by how much they block the spec. Cover
   the discovery areas: problem and users, how the client operates, functions (must / should /
   could), non-functional requirements, stack and integrations, data and data protection, budget,
   hard dates, who accepts and what "done" means, maintenance after launch.
2. **digest** (after a meeting). From notes, a transcript or a recording, add new decisions as
   `proposed`, open and close questions, update `client.md`, record the changes in the meeting
   file, and draft a recap in `recaps/`. A contradiction with an `agreed` decision is flagged and
   put to the human; the skill never supersedes on its own.
3. **confirm**. When the client confirms a recap, the named decisions become `agreed` with the
   confirmation reference.
4. **interview** (pet project). Questions one at a time through `AskUserQuestion`, over the same
   discovery areas; each answer is recorded as `agreed` with `Confirmed by: self`. No `client.md`
   and no recap.
5. **spec**. Allowed only when `status` reports no open question with `Blocks spec: yes`. Writes
   `docs/spec.md` and `docs/roadmap.md` into the project repo (into `brains/<name>/spec/` when no
   repo exists yet). Every spec item cites its `D-nnn`. `proposed` decisions go to a separate
   "Unconfirmed" section. The roadmap has an MVP and later phases, estimates as ranges, and
   deadlines taken from `deadline` decisions. Hand-off: tickets through `flow-write-ticket`, the
   profile through `flow-onboard-project`.

## Rules

- The skill never sends anything. Recaps are drafts; the human sends them.
- Nothing from `client.md` reaches the project repo. The spec carries what the team building the
  project needs.
- No profile-resolution step: the profile does not exist yet.
- The skill text names no client, person or project, so `lib/leak-guard.sh` passes.

## discovery.mjs

- `new <name> [--pet]`: scaffold the brain from the templates and `git init` it. `--pet` omits
  `client.md` and `recaps/`.
- `check <brain> [--spec <dir>]`: exit 0, or exit 1 with one line per violation:
  - duplicate `D-` or `Q-` id;
  - `agreed` without `Confirmed by`;
  - `superseded` without `Superseded by`, or pointing to a missing id;
  - `Supersedes` and `Superseded by` that do not mirror each other;
  - with `--spec`: a cited `D-nnn` that is missing or `superseded`.
- `status <brain>`: decisions awaiting confirmation, open questions per area, and a spec-readiness
  line (`ready` or the blocking question ids).

## Testing

`node:test` over synthetic brains in `lib/testing/fixtures/discovery/`: one valid brain and one fixture per
violation. Each violation test first runs against a brain known to contain that violation, so a
check that reports nothing cannot pass.

## Integration

- `install.sh all` picks up the new skill through the existing `flow-*` glob.
- A routing row for the personal `CLAUDE.md`: agreeing a new project or spec with a client or
  alone → `flow-discovery`; never auto-use `superpowers:brainstorming` for this job.
- `docs/adding-a-project.md` gains a line: discovery comes before onboarding.

## Out of scope

- Creating the repo, scaffolding a stack, creating tickets.
- A document shared with the client; the recap e-mail is the shared surface.
- Pulling meeting transcripts automatically; the human supplies them.
