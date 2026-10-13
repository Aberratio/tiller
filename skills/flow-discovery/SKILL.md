---
name: flow-discovery
description: Agree what a new project is before any code - with a client (prepare a meeting, digest its notes or transcript, draft the recap, record what the client confirmed) or alone for a pet project (a live interview) - and end with a spec and a phased roadmap with deadlines. Keeps a register of decisions and open questions in a brain, so any line of the spec can be traced to when it was agreed and on what evidence. Use when the user starts a new project from scratch, says "new client", "discovery", "kickoff", "prepare the meeting with <client>", "here are the notes from the call", "the client confirmed", "let's spec my side project", or asks what is still open before a spec.
user-invocable: true
---

# flow-discovery

There is no profile-resolution step: the project has no profile yet. Discovery ends where
`flow-onboard-project` begins.

```bash
D="node $TILLER_HOME/lib/discovery/discovery.mjs"
```

## Rules

- **The register is the record.** Every decision is a `D-nnn` in `decisions.md`, every open
  question a `Q-nnn` in `questions.md`, in the format the templates show. Run `$D check <name>`
  after every write; exit 1 lists what to fix, and a session never ends on a failing check.
- **Agreed means the client confirmed.** A decision from a meeting is `proposed`. It becomes
  `agreed` only in **confirm**, with `Confirmed by:` naming the e-mail (date and subject). In a pet
  project the human's answer is the confirmation: `Confirmed by: self`.
- **Never supersede on your own.** When new notes contradict an `agreed` decision, put the
  contradiction to the human with `AskUserQuestion`. Only on their word: a new `D-nnn` with
  `Supersedes:`, the old one `superseded` with `Superseded by:`.
- **Nothing is sent.** Recaps are drafts in `recaps/`; the human sends them.
- **The brain is private, the spec is not.** Nothing from `client.md` (people, politics, budget
  reasoning) goes into the spec; the spec carries what the team building the project needs.
- **One question at a time** when asking the human, through `AskUserQuestion`, recommendation first.

## Discovery areas

Problem and users · how the client operates · functions (must / should / could) · non-functional
requirements · stack and integrations · data and data protection · budget · hard dates · who
accepts and what "done" means · maintenance after launch. A spec is not ready while an area that
matters to this project has an open question with `Blocks spec: yes`.

## Steps

0. **Brain.** `$D new <name>` for a client, `$D new <name> --pet` for a pet project. Exit 3 means
   it exists: carry on with it. The human grants the session access with
   `$TILLER_HOME/lib/brain-access.sh` if the private-access hook denies a read.
1. **prep** (before a meeting). Read `client.md`, `$D status <name>`, and the open questions.
   Copy `lib/discovery/templates/meeting.md` to `meetings/<YYYY-MM-DD>-<slug>.md` and write the
   agenda: blocking questions first, then the discovery areas with nothing recorded yet. Each
   agenda item names the `Q-nnn` it should close or opens one.
2. **digest** (after a meeting). The human gives notes, a transcript or a recording reference.
   Record it under `## Source`, summarise under `## Digest`, then: new decisions as `proposed`,
   questions opened and closed, `client.md` updated, and each change as one line under
   `## Register changes`. Contradictions with `agreed` decisions go to the human (Rules). Draft
   the recap from `templates/recap.md` into `recaps/<YYYY-MM-DD>.md`, listing every `proposed`
   decision and every open question owned by the client.
3. **confirm**. When the human says the client confirmed (or corrected) a recap: confirmed
   decisions get `Status: agreed` and `Confirmed by:`; corrections become new `proposed`
   decisions and go into the next recap.
4. **interview** (pet project). Walk the discovery areas with `AskUserQuestion`, one question at
   a time; record each answer as `agreed`, `Confirmed by: self`, and each "not sure yet" as a
   `Q-nnn` owned by `me`.
5. **spec**. Only when `$D status <name>` prints `spec: ready`. Write `docs/spec.md` and
   `docs/roadmap.md` in the project repo, or in `brains/<name>/spec/` when there is no repo yet.
   Every item cites its `D-nnn`; `proposed` decisions go under `## Unconfirmed`. The roadmap has
   an MVP and later phases, each with an estimate as a range and a date from a `deadline`
   decision. Run `$D check <name> --spec <dir>` until it exits 0. Then hand off in one line each:
   tickets through `flow-write-ticket`, the profile through `flow-onboard-project`.

Each step ends with a commit in the brain (`git -C <brain> commit`), so the register's history
is the history of the conversation.
